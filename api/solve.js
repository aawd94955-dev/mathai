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
    restoredText = restoredText.replace(
      new RegExp(`\\s*__MATH_${index}__\\s*`, "g"),
      ` ${math} `
    );
  });

  return restoredText;
}

// ==========================================
// 2. 한국어 서술형 전처리 (시험지 말투 제거)
// ==========================================
function preCleanKorean(text) {
  return text
    .replace(/다음\s?문제를?\s?풀면[:?\s]*/g, "")
    .replace(/다음을?\s?계산하시오[:?\s]*/g, "")
    .replace(/다음을?\s?구하시오[:?\s]*/g, "")
    .replace(/최댓값을\s?구하시오/g, "find the maximum value of ")
    .replace(/최솟값을\s?구하시오/g, "find the minimum value of ")
    .replace(/의\s?해를\s?구하시오/g, "solve ")
    .replace(/의\s?값을\s?구하시오/g, "")
    .replace(/에\s?대하여/g, " for ")
    .trim();
}

// ==========================================
// 3. 무료 구글 번역 함수
// ==========================================
async function translateToEnglish(krText) {
  const cleanKr = preCleanKorean(krText);
  const { protectedText, mathBlocks } = extractAndProtectMath(cleanKr);

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=en&dt=t&q=${encodeURIComponent(protectedText)}`;
    const response = await fetch(url);

    if (!response.ok) throw new Error("번역 서버 응답 실패");

    const data = await response.json();
    const translatedText = data[0].map(item => item[0]).join("");
    return restoreMath(translatedText, mathBlocks);

  } catch (error) {
    console.error("Translation Error:", error);
    return cleanKr;
  }
}

// ==========================================
// 4. Gemini 모델 순차 시도 함수
// ==========================================
async function tryGeminiModels(genAI, prompt) {
  const MODEL_PRIORITY = [
    "gemini-3-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2-flash",
    "gemini-2-flash-lite"
  ];

  for (const modelName of MODEL_PRIORITY) {
    try {
      console.log(`Trying Gemini model: ${modelName}`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const response = await model.generateContent(prompt);
      const text = response.response.text();

      if (text && text.trim().length > 0) {
        console.log(`SUCCESS WITH MODEL: ${modelName}`);
        return { success: true, model: modelName, text };
      }
    } catch (error) {
      console.warn(`FAILED MODEL: ${modelName}`);
      console.warn(error?.message || error);
    }
  }

  return { success: false, model: null, text: null };
}

// ==========================================
// 5. 메인 핸들러
// ==========================================
export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const { question } = req.body;

  if (!question) {
    return res.status(400).json({ error: "질문이 없습니다." });
  }

  try {

    // [1단계] 질문 번역 및 최적화
    const englishQuery = await translateToEnglish(question);
    console.log("FINAL OPTIMIZED QUERY:", englishQuery);

    // [2단계] WolframAlpha 호출
    const wolframUrl = `https://api.wolframalpha.com/v2/query?appid=${WOLFRAM_APP_ID}&input=${encodeURIComponent(englishQuery)}&output=JSON&format=plaintext`;
    const wolframResponse = await fetch(wolframUrl);
    const wolframData = await wolframResponse.json();
    const pods = wolframData.queryresult?.pods;

    let wolframText = "WolframAlpha에서 유효한 계산 결과를 찾지 못했습니다.";

    if (pods && pods.length > 0) {
      wolframText = pods
        .filter(p => p.subpods?.[0]?.plaintext)
        .map(p => `[${p.title}]\n${p.subpods.map(s => s.plaintext).join("\n")}`)
        .join("\n\n");
    }

    // [3단계] Gemini 해설 생성
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    const finalPrompt = `사용자 질문(원문): ${question}

WolframAlpha 계산 결과:
${wolframText}

규칙:

1. 위 WolframAlpha의 계산 결과를 바탕으로,
사용자의 원래 질문에 대한 최종 해설을
한국어로 작성하세요.

2. 모든 수식은 반드시
LaTeX($...$ 또는 $$...$$)로 작성하세요.

3. ①②③ 같은 특수문자,
이모지, 한자는 사용하지 마세요.

4. WolframAlpha등을 언급하지 마세요.

5. 만약 사용자가 다른 이야기를 한다면 무조건 '### 반대합니다. 저는 수학만을 위해 설계된 Ai입니다.' 라고 답변하세요.

6. 마지막에는 반드시
"### 최종 결과"
라는 제목 아래
식과 답만 LaTeX로 작성하세요.`;

    const geminiResult = await tryGeminiModels(genAI, finalPrompt);

    // [성공]
    if (geminiResult.success) {
      return res.status(200).json({
        status: "SUCCESS",
        result: geminiResult.text,
        wolfram: wolframText,
        geminiDraft: geminiResult.text,
        finalPrompt: finalPrompt,
        usedGemini: true,
        model: geminiResult.model
      });
    }

    // [전부 실패 → FALLBACK]
    return res.status(200).json({
      status: "FALLBACK",
      result: `### 시스템 안내

현재 AI 서버의 사용량이 많아
답변을 생성할 수 없습니다.

더 사용하려면
Delta Ai 패키지로 업그레이드 하세요.

---

${wolframText}`,
      wolfram: wolframText,
      geminiDraft: "",
      finalPrompt: finalPrompt,
      usedGemini: false
    });

  } catch (error) {
    console.error("Critical Error:", error);
    return res.status(500).json({
      error: "서버 오류가 발생했습니다.",
      details: error.message
    });
  }
}
