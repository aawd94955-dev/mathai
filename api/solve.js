import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID;

const SYSTEM_PROMPT = `당신은 수학 전문 AI입니다.
규칙:
1. 모든 수식, 숫자, 변수는 반드시 LaTeX로 감싸세요. 인라인은 $...$, 블록은 $$...$$
2. 절대로 ①②③ 같은 특수문자, 한자, 이모지를 사용하지 마세요.
3. 단계 표시는 반드시 "1.", "2.", "3." 형식만 사용하세요.
4. 수학과 관련이 없으면 '반대합니다. 저는 수학만을 위한 AI입니다.'라고만 답변하세요.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "질문이 없습니다." });

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

    const [geminiResult, wolframResult] = await Promise.allSettled([
      model.generateContent(`${SYSTEM_PROMPT}\n\n문제: ${question}`),
      (async () => {
        const url = `https://api.wolframalpha.com/v2/query?appid=${WOLFRAM_APP_ID}&input=${encodeURIComponent(question)}&output=JSON&format=plaintext`;
        console.log("WOLFRAM URL:", url);

        const r = await fetch(url);
        console.log("WOLFRAM STATUS:", r.status, r.statusText);

        if (!r.ok) return `WolframAlpha 오류: ${r.status} ${r.statusText}`;

        const data = await r.json();
        console.log("WOLFRAM RAW:", JSON.stringify(data?.queryresult, null, 2));

        const pods = data.queryresult?.pods;
        if (!pods || pods.length === 0) return "WolframAlpha 계산 결과 없음";

        return pods
          .filter(p => p.subpods?.[0]?.plaintext)
          .map(p => `[${p.title}]\n${p.subpods.map(s => s.plaintext).join('\n')}`)
          .join('\n\n') || "WolframAlpha 계산 결과 없음";
      })()
    ]);

    const geminiText = geminiResult.status === "fulfilled"
      ? geminiResult.value.response.text()
      : "Gemini 응답 실패";

    const wolframText = wolframResult.status === "fulfilled"
      ? wolframResult.value
      : `WolframAlpha 호출 실패: ${wolframResult.reason}`;

    if (geminiText.includes("반대합니다")) {
      return res.status(200).json({ result: "반대합니다. 저는 수학만을 위한 AI입니다." });
    }

    const finalPrompt = `사용자 질문: ${question}
AI 초기 풀이: ${geminiText}
검증 데이터(WolframAlpha): ${wolframText}

규칙:
1. 모든 수식은 반드시 LaTeX($...$ 또는 $$...$$)로 작성하세요.
2. ①②③ 같은 특수문자, 이모지, 한자는 절대 사용하지 마세요.
3. 단계는 "1.", "2.", "3." 숫자 형식만 사용하세요.
4. 위 풀이와 검증 데이터를 비교하여 최종 단계별 풀이를 작성하세요.
5. 마지막에는 반드시 "최종 결과" 라는 제목 아래 식과 답만 LaTeX로 작성하세요.`;

    const finalResponse = await model.generateContent(finalPrompt);
    const finalText = finalResponse.response.text();

    res.status(200).json({
      result: finalText,
      geminiDraft: geminiText,
      wolfram: wolframText,
      finalPrompt: finalPrompt
    });

  } catch (error) {
    console.error("Critical Error:", error);
    res.status(500).json({
      error: "서버 오류가 발생했습니다.",
      details: error.message
    });
  }
}
