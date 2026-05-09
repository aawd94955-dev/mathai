import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID;

// ==========================================
// 1. 수식(LaTeX) 보호 및 복원 유틸리티
// ==========================================
function extractAndProtectMath(text) {
  const mathRegex = /(\$\$[\s\S]*?\$\$|\$.*?\$)/g;
  const mathBlocks = [];
  let counter = 0;

  const protectedText = text.replace(mathRegex, (match) => {
    const placeholder = ` __MATH_${counter}__ `; 
    mathBlocks.push(match);
    counter++;
    return placeholder;
  });

  return { protectedText, mathBlocks };
}

function restoreMath(text, mathBlocks) {
  let restoredText = text;
  mathBlocks.forEach((math, index) => {
    restoredText = restoredText.replace(new RegExp(`\\s*__MATH_${index}__\\s*`, 'g'), ` ${math} `);
  });
  return restoredText;
}

// ==========================================
// 2. 무료 구글 번역 함수 (카드/키 필요 없음)
// ==========================================
async function translateToEnglish(krText) {
  const { protectedText, mathBlocks } = extractAndProtectMath(krText);

  try {
    // 구글 번역 무료 엔드포인트 활용
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=en&dt=t&q=${encodeURIComponent(protectedText)}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error("번역 서버 응답 실패");
    
    const data = await response.json();
    // 구글 번역 응답 구조에서 텍스트 추출
    const translatedText = data[0].map(item => item[0]).join('');

    return restoreMath(translatedText, mathBlocks);
  } catch (error) {
    console.error("Translation Error:", error);
    return krText; // 번역 실패 시 원본이라도 반환
  }
}

// ==========================================
// 3. 메인 핸들러
// ==========================================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "질문이 없습니다." });

  try {
    // [단계 1] 질문 번역 (한글 -> 영어)
    // 수식은 보호하면서 울프람이 이해하기 쉽게 영어로 바꿉니다.
    const englishQuery = await translateToEnglish(question);
    console.log("TRANSLATED QUERY:", englishQuery);

    // [단계 2] WolframAlpha 호출 (영문 쿼리 사용)
    const wolframUrl = `https://api.wolframalpha.com/v2/query?appid=${WOLFRAM_APP_ID}&input=${encodeURIComponent(englishQuery)}&output=JSON&format=plaintext`;
    const r = await fetch(wolframUrl);
    const data = await r.json();

    const pods = data.queryresult?.pods;
    let wolframText = "WolframAlpha에서 유효한 계산 결과를 찾지 못했습니다.";
    if (pods && pods.length > 0) {
      wolframText = pods
        .filter(p => p.subpods?.[0]?.plaintext)
        .map(p => `[${p.title}]\n${p.subpods.map(s => s.plaintext).join('\n')}`)
        .join('\n\n');
    }

    // [단계 3] Gemini 최종 해설 생성 시도
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash" }); // 모델명 확인

    const finalPrompt = `사용자 질문(원문): ${question}
WolframAlpha 계산 결과: ${wolframText}

규칙:
1. 위 WolframAlpha의 계산 결과를 바탕으로, 사용자의 원래 질문에 대한 최종 해설을 한국어로 작성하세요.
2. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
3. ①②③ 같은 특수문자, 이모지, 한자는 사용하지 마세요.
4. 마지막에는 반드시 "### 최종 결과" 라는 제목 아래 식과 답만 LaTeX로 작성하세요.`;

    try {
      // 제미나이 호출
      const finalResponse = await model.generateContent(finalPrompt);
      const finalText = finalResponse.response.text();

      return res.status(200).json({
        status: "SUCCESS",
        result: finalText,
        usedGemini: true
      });

    } catch (geminiError) {
      // 🚨 제미나이 할당량 초과 시 (429 에러 등) 🚨
      console.warn("Gemini Quota Exceeded. Falling back to Wolfram results.");

      return res.status(200).json({
        status: "FALLBACK",
        result: `### 시스템 안내\n현재 AI 해설 서버의 트래픽이 많아 정밀 해설을 생성할 수 없습니다. 시스템의 원본 계산 결과를 대신 보여드립니다.\n\n---\n\n${wolframText}`,
        usedGemini: false
      });
    }

  } catch (error) {
    console.error("Critical Error:", error);
    res.status(500).json({
      error: "서버 오류가 발생했습니다.",
      details: error.message
    });
  }
}
