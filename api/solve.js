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
// 2. 한국어 서술형 전처리 (시험지 말투 제거)
// ==========================================
function preCleanKorean(text) {
  return text
    // 1. 문두의 불필요한 도입부 제거
    .replace(/다음\s?문제를?\s?풀면[:?\s]*/g, '')
    .replace(/다음을?\s?계산하시오[:?\s]*/g, '')
    .replace(/다음을?\s?구하시오[:?\s]*/g, '')
    // 2. 핵심 키워드를 울프람이 좋아하는 명확한 단어로 암시적 변환
    .replace(/최댓값을\s?구하시오/g, 'find the maximum value of ')
    .replace(/최솟값을\s?구하시오/g, 'find the minimum value of ')
    .replace(/의\s?해를\s?구하시오/g, 'solve ')
    .replace(/의\s?값을\s?구하시오/g, '')
    .replace(/에\s?대하여/g, ' for ')
    .trim();
}

// ==========================================
// 3. 무료 구글 번역 함수 (카드/키 필요 없음)
// ==========================================
async function translateToEnglish(krText) {
  // 번역 전 한국어 수식어 정리
  const cleanKr = preCleanKorean(krText);
  
  // 수식 보호
  const { protectedText, mathBlocks } = extractAndProtectMath(cleanKr);

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=en&dt=t&q=${encodeURIComponent(protectedText)}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error("번역 서버 응답 실패");
    
    const data = await response.json();
    const translatedText = data[0].map(item => item[0]).join('');

    // 수식 복원
    return restoreMath(translatedText, mathBlocks);
  } catch (error) {
    console.error("Translation Error:", error);
    return cleanKr; // 실패 시 전처리된 한글이라도 반환하여 울프람 시도
  }
}

// ==========================================
// 4. 메인 핸들러
// ==========================================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "질문이 없습니다." });

  try {
    // [단계 1] 질문 번역 및 최적화
    const englishQuery = await translateToEnglish(question);
    console.log("FINAL OPTIMIZED QUERY:", englishQuery);

    // [단계 2] WolframAlpha 호출
    const wolframUrl = `https://api.wolframalpha.com/v2/query?appid=${WOLFRAM_APP_ID}&input=${encodeURIComponent(englishQuery)}&output=JSON&format=plaintext`;
    const r = await fetch(wolframUrl);
    const data = await r.json();

    const pods = data.queryresult?.pods;
    let wolframText = "Delta Ai로 업그레이드 하여 정답 보기.";
    if (pods && pods.length > 0) {
      wolframText = pods
        .filter(p => p.subpods?.[0]?.plaintext)
        .map(p => `[${p.title}]\n${p.subpods.map(s => s.plaintext).join('\n')}`)
        .join('\n\n');
    }

    // [단계 3] Gemini 최종 해설 생성 시도
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash" }); 

    const finalPrompt = `사용자 질문(원문): ${question}
WolframAlpha 계산 결과: ${wolframText}

규칙:
1. 위 WolframAlpha의 계산 결과를 바탕으로, 사용자의 원래 질문에 대한 최종 해설을 한국어로 작성하세요.
2. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
3. ①②③ 같은 특수문자, 이모지, 한자는 사용하지 마세요.
4. 마지막에는 반드시 "### 최종 결과" 라는 제목 아래 식과 답만 LaTeX로 작성하세요.`;

    try {
      const finalResponse = await model.generateContent(finalPrompt);
      const finalText = finalResponse.response.text();

      return res.status(200).json({
        status: "SUCCESS",
        result: finalText,
        usedGemini: true
      });

    } catch (geminiError) {
      console.warn("Gemini Quota Exceeded.");
      return res.status(200).json({
        status: "FALLBACK",
        ### 시스템 안내\n현재 Log Ai의 사용량이 많습니다. 먼저 사용하려면 Delta Ai 패키지로 업그레이드 하세요.\n\n\n\n${wolframText}
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
