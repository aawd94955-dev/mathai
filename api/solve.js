import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID;
const DEEPL_API_KEY = process.env.DEEPL_API_KEY; // DeepL API 키 추가

// ==========================================
// 1. 수식(LaTeX) 보호 및 복원 유틸리티
// ==========================================
function extractAndProtectMath(text) {
  // $...$ 또는 $$...$$ 형태의 수식을 모두 찾습니다.
  const mathRegex = /(\$\$[\s\S]*?\$\$|\$.*?\$)/g;
  const mathBlocks = [];
  let counter = 0;

  const protectedText = text.replace(mathRegex, (match) => {
    const placeholder = ` __MATH_${counter}__ `; // 번역기가 건드리지 않을 특수 단어
    mathBlocks.push(match);
    counter++;
    return placeholder;
  });

  return { protectedText, mathBlocks };
}

function restoreMath(text, mathBlocks) {
  let restoredText = text;
  mathBlocks.forEach((math, index) => {
    // 번역된 텍스트에 다시 원래 수식을 끼워 넣습니다.
    restoredText = restoredText.replace(new RegExp(`\\s*__MATH_${index}__\\s*`, 'g'), ` ${math} `);
  });
  return restoredText;
}

// ==========================================
// 2. DeepL API를 이용한 영어 번역 (수식 보호 포함)
// ==========================================
async function translateToEnglish(krText) {
  // 수식 숨기기
  const { protectedText, mathBlocks } = extractAndProtectMath(krText);

  // DeepL 무료 API 호출
  const response = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      "Authorization": `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: [protectedText],
      target_lang: "EN" // 영어로 번역
    })
  });

  if (!response.ok) throw new Error("번역 API 호출 실패");
  const data = await response.json();
  const translatedText = data.translations[0].text;

  // 숨겼던 수식 다시 복구하기
  return restoreMath(translatedText, mathBlocks);
}

// ==========================================
// 3. 메인 핸들러
// ==========================================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "질문이 없습니다." });

  try {
    // [단계 1] 질문 번역 (한글 -> 영어, 수식은 그대로 유지)
    const englishQuery = await translateToEnglish(question);
    console.log("TRANSLATED QUERY:", englishQuery);

    // [단계 2] WolframAlpha 호출
    const wolframUrl = `https://api.wolframalpha.com/v2/query?appid=${WOLFRAM_APP_ID}&input=${encodeURIComponent(englishQuery)}&output=JSON&format=plaintext`;
    const r = await fetch(wolframUrl);
    const data = await r.json();

    const pods = data.queryresult?.pods;
    let wolframText = "WolframAlpha 계산 결과 없음 (또는 해석 불가)";
    if (pods && pods.length > 0) {
      wolframText = pods
        .filter(p => p.subpods?.[0]?.plaintext)
        .map(p => `[${p.title}]\n${p.subpods.map(s => s.plaintext).join('\n')}`)
        .join('\n\n');
    }

    // [단계 3] Gemini 최종 해설 생성 시도
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

    const finalPrompt = `사용자 질문(원문): ${question}
WolframAlpha 계산 결과: ${wolframText}

규칙:
1. 위 WolframAlpha의 계산 결과를 바탕으로, 사용자의 원래 질문에 대한 최종 해설을 한국어로 작성하세요.
2. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
3. ①②③ 같은 특수문자는 사용하지 마세요.
4. 마지막에는 반드시 "최종 결과" 라는 제목 아래 식과 답만 LaTeX로 작성하세요.`;

    try {
      // 제미나이 호출 시도
      const finalResponse = await model.generateContent(finalPrompt);
      const finalText = finalResponse.response.text();

      // 성공 시: 제미나이의 예쁜 해설 반환
      return res.status(200).json({
        status: "SUCCESS",
        result: finalText,
        usedGemini: true
      });

    } catch (geminiError) {
      // 🚨 제미나이 호출 실패 (429 할당량 초과 등) 🚨
      console.warn("Gemini Error / Quota Exceeded:", geminiError.message);

      // 제미나이가 뻗었으므로, 울프람의 날 것(Raw) 결과를 사용자에게 반환
      return res.status(200).json({
        status: "FALLBACK",
        result: `*현재 AI 해설 서버에 요청이 많아, 시스템의 원본 계산 결과만 먼저 보여드립니다.*\n\n${wolframText}`,
        usedGemini: false
      });
    }

  } catch (error) {
    // 번역기나 시스템 자체의 치명적인 에러
    console.error("Critical Error:", error);
    res.status(500).json({
      error: "서버 처리 중 오류가 발생했습니다.",
      details: error.message
    });
  }
}
