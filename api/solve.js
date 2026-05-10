import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const WOLFRAM_APP_ID     = process.env.WOLFRAM_APP_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ==========================================
// 1차 풀이 프롬프트 (GPT·Gemini 공용)
// ==========================================
function buildSolvePrompt(question, wolframSection, hasImage) {
  return `너는 수학 문제 풀이 전용 AI다.

사용자 질문: ${question}${hasImage ? "\n(첨부 이미지 속 수학 문제도 함께 인식하여 풀이하라.)" : ""}

${wolframSection}

[규칙 1] 수식·함수·방정식·극한·적분·미분·수열·수학 기호가 하나라도 포함되면 수학 문제로 간주하고 한국어로 풀이하라.
[규칙 2] 수학 표현에만 LaTeX 사용. 인라인 $...$, 독립 $$...$$. 일반 문장은 일반 텍스트.
[규칙 3] ①②③ 같은 원문자, 이모지, 한자, 불필요한 특수문자 사용 금지.
[규칙 4] WolframAlpha·CAS·Mathematica·Sympy 등 외부 도구 언급 금지.
[규칙 5] 수학과 무관한 질문이면 "### 반대합니다. 저는 수학만을 위해 설계된 AI입니다." 만 출력하고 종료.
[규칙 6] 풀이는 논리 비약 없이 단계별로 작성. 미분·적분·극한 중간 과정 생략 금지.
[규칙 7] 풀기 전 정의역·특수값 대입·분모 0 여부 등 간단한 검증 먼저 수행.
[규칙 8] 최종 답변 끝에 반드시:

### 최종 결과

(식과 답만 작성, 설명 문장 없음)`;
}

// ==========================================
// 교차 검증 프롬프트 (Gemini가 두 풀이 비교)
// ==========================================
function buildVerifyPrompt(question, gptDraft, geminiDraft, wolframSection, hasImage) {
  return `너는 수학 교차 검증 전문 AI다.

원래 문제: ${question}${hasImage ? "\n(이미지 포함 문제)" : ""}

${wolframSection}

아래 두 AI가 각각 독립적으로 풀이한 결과를 교차 검증하라.

=== AI-A (GPT) 풀이 ===
${gptDraft}

=== AI-B (Gemini) 풀이 ===
${geminiDraft}

[검증 규칙 1] 두 풀이가 일치하면 해당 답을 최종 채택하고 풀이를 깔끔하게 정리하라.
[검증 규칙 2] 두 풀이가 다르면 어느 단계에서 차이가 발생했는지 수식으로 정확히 지적하라.
[검증 규칙 3] 틀린 풀이가 있으면 오류 원인을 설명하고, 올바른 계산을 직접 제시하라.
[검증 규칙 4] WolframAlpha 결과가 있으면 함께 참고하여 최종 답을 확정하라.
[검증 규칙 5] 수학 표현에만 LaTeX 사용. 인라인 $...$, 독립 $$...$$.
[검증 규칙 6] ①②③ 원문자, 이모지, 한자, 외부 도구 언급 금지.
[검증 규칙 7] 최종 답변 끝에 반드시:

### 최종 결과

(식과 답만 작성, 설명 문장 없음)`;
}

// ==========================================
// 수식 보호 / 복원 유틸
// ==========================================
function extractAndProtectMath(text) {
  const mathBlocks = [];
  let counter = 0;
  const protectedText = text.replace(/(\$\$[\s\S]*?\$\$|\$.*?\$)/g, (match) => {
    mathBlocks.push(match);
    return ` __MATH_${counter++}__ `;
  });
  return { protectedText, mathBlocks };
}
function restoreMath(text, mathBlocks) {
  return mathBlocks.reduce((t, math, i) =>
    t.replace(new RegExp(`\\s*__MATH_${i}__\\s*`, "g"), ` ${math} `), text);
}

// ==========================================
// 한국어 전처리
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
// 번역 (WolframAlpha용)
// ==========================================
async function translateToEnglish(krText) {
  const cleanKr = preCleanKorean(krText);
  const { protectedText, mathBlocks } = extractAndProtectMath(cleanKr);
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=en&dt=t&q=${encodeURIComponent(protectedText)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("번역 서버 오류");
    const data = await res.json();
    return restoreMath(data[0].map(i => i[0]).join(""), mathBlocks);
  } catch (e) {
    console.error("Translation Error:", e);
    return cleanKr;
  }
}

// ==========================================
// OpenRouter 호출 (GPT 1차 풀이)
// ==========================================
async function callOpenRouter(prompt, imageBase64, imageMime, model = "openai/gpt-4o") {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY가 설정되지 않았습니다.");

  const userContent = (imageBase64 && imageMime)
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageBase64 } }]
    : prompt;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.SITE_URL || "https://your-site.com",
      "X-Title": "수학 교차 검증 AI"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: userContent }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${err}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter 응답이 비어 있습니다.");
  return { success: true, model: data.model || model, text };
}

// ==========================================
// Gemini 호출 (2차 풀이 + 교차검증)
// ==========================================
async function callGemini(prompt, imageBase64, imageMime) {
  const MODELS = [
    "gemini-2.5-flash-preview-05-20",
    "gemini-2.5-pro-preview-05-06",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
  ];
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  for (const modelName of MODELS) {
    try {
      console.log(`Gemini trying: ${modelName}`);
      const model = genAI.getGenerativeModel({ model: modelName });

      let content;
      if (imageBase64 && imageMime) {
        const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, "");
        content = [
          { text: prompt },
          { inlineData: { mimeType: imageMime, data: base64Data } }
        ];
      } else {
        content = prompt;
      }

      const response = await model.generateContent(content);
      const text = response.response.text();
      if (text?.trim()) {
        console.log(`Gemini OK: ${modelName}`);
        return { success: true, model: modelName, text };
      }
    } catch (e) {
      console.warn(`Gemini FAIL: ${modelName}`, e?.message);
    }
  }
  return { success: false, model: null, text: null };
}

// ==========================================
// 메인 핸들러
// ==========================================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    question    = "",
    imageBase64 = null,
    imageMime   = null,
    gptModel    = "openai/gpt-4o",
  } = req.body;

  const hasImage = !!imageBase64;
  const effectiveQuestion = question || (hasImage ? "이미지 속 수학 문제를 풀어라." : "");

  if (!effectiveQuestion && !hasImage) {
    return res.status(400).json({ error: "질문이 없습니다." });
  }

  try {
    // ── Step 1: WolframAlpha ──────────────────────────────────────────
    let wolframText = "";
    if (question) {
      const englishQuery = await translateToEnglish(question);
      try {
        const wUrl = `https://api.wolframalpha.com/v2/query?appid=${WOLFRAM_APP_ID}&input=${encodeURIComponent(englishQuery)}&output=JSON&format=plaintext`;
        const wRes  = await fetch(wUrl);
        const wData = await wRes.json();
        const pods  = wData.queryresult?.pods;
        if (pods?.length) {
          wolframText = pods
            .filter(p => p.subpods?.[0]?.plaintext)
            .map(p => `[${p.title}]\n${p.subpods.map(s => s.plaintext).join("\n")}`)
            .join("\n\n");
        }
      } catch (e) { console.warn("Wolfram 오류:", e.message); }
    }

    const wolframSection = wolframText
      ? `참고 계산 결과 (WolframAlpha):\n${wolframText}`
      : "(WolframAlpha 계산 결과 없음)";

    const solvePrompt = buildSolvePrompt(effectiveQuestion, wolframSection, hasImage);

    // ── Step 2: GPT(OpenRouter) + Gemini 병렬 1차 풀이 ───────────────
    console.log("병렬 1차 풀이 시작: GPT + Gemini");
    const [gptSettled, geminiSettled] = await Promise.allSettled([
      callOpenRouter(solvePrompt, imageBase64, imageMime, gptModel),
      callGemini(solvePrompt, imageBase64, imageMime),
    ]);

    const gptOk     = gptSettled.status === "fulfilled" && gptSettled.value.success;
    const geminiOk  = geminiSettled.status === "fulfilled" && geminiSettled.value.success;

    const gptDraft    = gptOk    ? gptSettled.value.text    : `(GPT 풀이 실패: ${gptSettled.reason?.message ?? "오류"})`;
    const geminiDraft = geminiOk ? geminiSettled.value.text : `(Gemini 풀이 실패: ${geminiSettled.reason?.message ?? "오류"})`;

    const gptModelUsed    = gptOk    ? gptSettled.value.model    : gptModel;
    const geminiModelUsed = geminiOk ? geminiSettled.value.model : "gemini-unknown";

    console.log("GPT:", gptModelUsed, "| Gemini:", geminiModelUsed);

    // ── Step 3: Gemini 교차 검증 ──────────────────────────────────────
    // 검증 단계는 텍스트만 (두 드래프트가 이미 이미지 내용 반영)
    console.log("교차 검증 시작...");
    const verifyPrompt = buildVerifyPrompt(
      effectiveQuestion, gptDraft, geminiDraft, wolframSection, hasImage
    );
    const verifyResult = await callGemini(verifyPrompt, null, null);

    if (verifyResult.success) {
      return res.status(200).json({
        status:       "SUCCESS",
        result:       verifyResult.text,   // 최종 교차검증 풀이
        gptDraft,                           // GPT 1차
        geminiDraft,                        // Gemini 1차
        wolfram:      wolframText || "계산 결과 없음",
        hasImage,
        gptModel:     gptModelUsed,
        geminiModel:  geminiModelUsed,
        verifyModel:  verifyResult.model,
      });
    }

    // 검증 실패 → 성공한 드래프트 반환
    return res.status(200).json({
      status:       "PARTIAL",
      result:       geminiOk ? geminiDraft : gptDraft,
      gptDraft,
      geminiDraft,
      wolfram:      wolframText || "계산 결과 없음",
      hasImage,
      gptModel:     gptModelUsed,
      geminiModel:  geminiModelUsed,
      verifyModel:  null,
    });

  } catch (error) {
    console.error("Critical Error:", error);
    return res.status(500).json({ error: "서버 오류", details: error.message });
  }
}
