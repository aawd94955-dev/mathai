import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID;

const SYSTEM_PROMPT = `당신은 수학 전문 AI입니다. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
수학과 관련이 없으면 '반대합니다. 저는 수학만을 위한 AI입니다.'라고만 답변하세요.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "질문이 없습니다." });

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    // 모델 이름을 'gemini-1.5-flash'로 설정합니다. 
    // 라이브러리 버전이 최신일 경우 'models/'를 생략하는 것이 가장 안정적입니다.
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 1단계: Gemini 초기 풀이 및 WolframAlpha 호출 (병렬 처리)
    const [geminiResult, wolframResult] = await Promise.allSettled([
      model.generateContent(`${SYSTEM_PROMPT}\n\n문제: ${question}`),
      fetch(`https://api.wolframalpha.com/v1/result?appid=${WOLFRAM_APP_ID}&i=${encodeURIComponent(question)}`)
        .then(r => r.ok ? r.text() : "WolframAlpha 계산 불가")
    ]);

    const geminiText = geminiResult.status === "fulfilled" ? geminiResult.value.response.text() : "Gemini 응답 실패";
    const wolframText = wolframResult.status === "fulfilled" ? wolframResult.value : "WolframAlpha 연결 실패";

    // 가드레일 확인
    if (geminiText.includes("반대합니다")) {
      return res.status(200).json({ result: "반대합니다. 저는 수학만을 위한 AI입니다." });
    }

    // 2단계: 교차 검증 및 최종 답변 생성
    const finalPrompt = `사용자 질문: ${question}\nGemini 풀이: ${geminiText}\nWolfram 정답: ${wolframText}\n위 정보를 비교하여 최종 풀이를 LaTeX로 작성하세요.`;
    const finalResponse = await model.generateContent(finalPrompt);

    res.status(200).json({ result: finalResponse.response.text() });
  } catch (error) {
    console.error("Critical Error:", error);
    // 404 에러가 계속될 경우를 대비해 에러 메시지를 구체적으로 반환합니다.
    res.status(500).json({ error: `모델 로드 실패: ${error.message}. API 키와 모델명을 확인하세요.` });
  }
}
