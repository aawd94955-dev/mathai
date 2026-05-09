import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID;

const SYSTEM_PROMPT = `당신은 수학 전문 AI입니다. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
가드레일: 수학과 관련이 없거나 이상한 이야기를 할 경우, 반드시 '반대합니다. 저는 수학만을 위한 AI입니다.'라고만 답변하세요.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: "질문이 제공되지 않았습니다." });
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    // 404 에러 방지를 위해 모델만 선언합니다.
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 1단계: 시스템 프롬프트를 질문 앞에 붙여 가드레일을 적용합니다.
    const initialPrompt = `${SYSTEM_PROMPT}\n\n사용자 질문: ${question}`;

    const [geminiResult, wolframResult] = await Promise.allSettled([
      model.generateContent(initialPrompt),
      fetch(`https://api.wolframalpha.com/v1/result?appid=${WOLFRAM_APP_ID}&i=${encodeURIComponent(question)}`).then(res => {
          if (!res.ok) throw new Error("WolframAlpha API Error");
          return res.text();
      })
    ]);

    const geminiText = geminiResult.status === "fulfilled" ? geminiResult.value.response.text() : "Gemini 연산 실패";
    const wolframText = wolframResult.status === "fulfilled" ? wolframResult.value : "WolframAlpha 연산 불가";

    // 가드레일 확인
    if (geminiText.includes("반대합니다")) {
      return res.status(200).json({ result: "반대합니다. 저는 수학만을 위한 AI입니다.", status: "rejected" });
    }

    // 2단계: 교차 검증 프롬프트
    const verificationPrompt = `
      사용자의 질문: ${question}
      초기 풀이: ${geminiText}
      WolframAlpha 결과: ${wolframText}

      위 정보를 바탕으로 최종 수학 풀이를 작성하세요. 
      모든 수식은 LaTeX($...$ 또는 $$...$$)를 사용해야 합니다.
    `;

    const finalResult = await model.generateContent(verificationPrompt);
    const finalText = finalResult.response.text();

    res.status(200).json({ result: finalText, status: "success" });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: "서버 내부 오류가 발생했습니다. 환경 변수와 API 키를 확인하세요." });
  }
}
