import { GoogleGenerativeAI } from "@google/generative-ai";

// Vercel 환경 변수에서 API 키를 가져옵니다.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID;

// 시스템 프롬프트 및 가드레일 설정
const SYSTEM_PROMPT = `당신은 수학 전문 AI입니다. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
가드레일: 수학과 관련이 없거나 이상한 이야기를 할 경우, 반드시 '반대합니다. 저는 수학만을 위한 AI입니다.'라고만 답변하세요.`;

export default async function handler(req, res) {
  // CORS 처리 및 POST 메서드 확인
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: "질문이 제공되지 않았습니다." });
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: SYSTEM_PROMPT,
    });

    // 1단계: Gemini의 초기 풀이와 WolframAlpha의 계산을 동시에 진행
    const [geminiResult, wolframResult] = await Promise.allSettled([
      model.generateContent(question),
      fetch(`https://api.wolframalpha.com/v1/result?appid=${WOLFRAM_APP_ID}&i=${encodeURIComponent(question)}`).then(res => {
          if (!res.ok) throw new Error("WolframAlpha API Error");
          return res.text();
      })
    ]);

    const geminiText = geminiResult.status === "fulfilled" ? geminiResult.value.response.text() : "Gemini 연산 실패";
    const wolframText = wolframResult.status === "fulfilled" ? wolframResult.value : "WolframAlpha 연산 불가 (수식이 아니거나 해석할 수 없음)";

    // 가드레일 작동 확인: 수학과 무관한 질문으로 차단된 경우 즉시 반환
    if (geminiText.includes("반대합니다. 저는 수학만을 위한 AI입니다.")) {
      return res.status(200).json({ result: "반대합니다. 저는 수학만을 위한 AI입니다.", status: "rejected" });
    }

    // 2단계: 교차 검증을 위한 최종 프롬프트 생성
    const verificationPrompt = `
      사용자의 질문: ${question}

      당신의 초기 풀이 결과:
      ${geminiText}

      WolframAlpha의 객관적 계산 결과 (참고자료):
      ${wolframText}

      지시사항:
      1. 당신의 초기 풀이와 WolframAlpha의 결과를 교차 검증하세요.
      2. 두 결과가 다를 경우, WolframAlpha의 답을 참고하여 오류를 찾아 수정하고 최종안(단계별 풀이)을 내놓으세요.
      3. 검토 후에도 최종적으로 두 답이 일치하지 않고 당신의 논리가 확실하다면, 사용자에게 두 답을 모두 제시하고 이유를 설명하세요.
      4. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
    `;

    // 3단계: Gemini에게 검증 프롬프트 전달 및 최종 답변 도출
    const finalResult = await model.generateContent(verificationPrompt);
    const finalText = finalResult.response.text();

    res.status(200).json({ result: finalText, status: "success" });
  } catch (error) {
    console.error("Error generating math solution:", error);
    res.status(500).json({ error: "서버 내부 오류가 발생했습니다." });
  }
}
