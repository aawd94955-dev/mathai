import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID;

const SYSTEM_PROMPT = `당신은 수학 전문 AI입니다. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
수학과 관련이 없으면 '반대합니다. 저는 수학만을 위한 AI입니다.'라고만 답변하세요.`;

export default async function handler(req, res) {
  // CORS 및 메서드 제한
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "질문이 없습니다." });

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    // 모델명에서 'models/'를 제거하고 순수하게 이름만 입력합니다.
    // 최신 SDK는 내부적으로 경로를 조합하므로 이 방식이 가장 에러가 적습니다.
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 1단계: 병렬로 Gemini 풀이와 WolframAlpha 결과 가져오기
    const [geminiResult, wolframResult] = await Promise.allSettled([
      model.generateContent(`${SYSTEM_PROMPT}\n\n문제: ${question}`),
      fetch(`https://api.wolframalpha.com/v1/result?appid=${WOLFRAM_APP_ID}&i=${encodeURIComponent(question)}`)
        .then(r => r.ok ? r.text() : "WolframAlpha 계산 결과 없음")
    ]);

    const geminiText = geminiResult.status === "fulfilled" ? geminiResult.value.response.text() : "Gemini 응답 실패";
    const wolframText = wolframResult.status === "fulfilled" ? wolframResult.value : "WolframAlpha 호출 실패";

    // 가드레일 작동 시 즉시 반환
    if (geminiText.includes("반대합니다")) {
      return res.status(200).json({ result: "반대합니다. 저는 수학만을 위한 AI입니다." });
    }

    // 2단계: 교차 검증을 통한 최종 답변 생성
    const finalPrompt = `
      사용자 질문: ${question}
      AI 초기 풀이: ${geminiText}
      검증 데이터(WolframAlpha): ${wolframText}
      
      위 내용을 비교하여 최종적인 단계별 풀이를 LaTeX 형식으로 작성하세요.
    `;
    
    const finalResponse = await model.generateContent(finalPrompt);
    res.status(200).json({ result: finalResponse.response.text() });

  } catch (error) {
    console.error("Critical Error:", error);
    res.status(500).json({ 
      error: "서버 오류가 발생했습니다.",
      details: error.message 
    });
  }
}
