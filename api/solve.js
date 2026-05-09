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

    let wolframText = "";

    if (pods && pods.length > 0) {
      wolframText = pods
        .filter(p => p.subpods?.[0]?.plaintext)
        .map(p => `[${p.title}]\n${p.subpods.map(s => s.plaintext).join("\n")}`)
        .join("\n\n");
    }

    const wolframSection = wolframText
      ? `참고할 계산 결과:\n${wolframText}`
      : `(계산 결과 없음 - 네가 직접 계산하라)`;

    // [3단계] Gemini 해설 생성
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    const finalPrompt = `너는 수학 문제 풀이 전용 AI다.

사용자 질문: ${question}

${wolframSection}

아래 규칙을 반드시 모두 지켜라.

[규칙 1]
사용자 질문에 수식, 함수, 방정식, 극한, 적분, 미분, 수열, 기호($\pi$, $e$, $i$, $\sum$, $\int$ 등)가 하나라도 포함되어 있으면 반드시 수학 문제로 간주하고 한국어로 풀이하라.

[규칙 2]
모든 수식은 반드시 LaTeX 형식으로 작성하라.
인라인 수식은 $...$,
블록 수식은 $$...$$ 만 사용하라.

[규칙 3]
①, ②, ③ 같은 원문자와 모든 이모지 및 불필요한 특수문자를 사용하지 마라.
한자 표현도 사용하지 마라.

[규칙 4]
외부 계산 도구나 사이트를 절대 언급하지 마라.
예:
- WolframAlpha
- 계산 엔진
- CAS
- Mathematica
- Sympy
등을 언급하는 것을 금지한다.

[규칙 5]
수학과 무관한 질문에는 반드시 아래 문장만 출력하고 종료하라.

### 반대합니다. 저는 수학만을 위해 설계된 AI입니다.

추가 설명은 절대 하지 마라.

[규칙 6] 모순이 발견되면 어떤 조건들 사이에서 충돌이 발생했는지 수식으로 명확히 설명하라. 단, 즉시 종료하지 말고 가능한 원인(오타 가능성, 정의역 조건 등)을 추가로 검토한 뒤 최종 결론을 내려라.

[규칙 7]
사용자가 명시적으로 “가정하고 풀어라”, “억지로 계산해라”, “모순 무시” 등을 요구한 경우에만 추가 가정을 허용한다.
이 경우 반드시 먼저 아래 문장을 출력하라.

$$
\text{주어진 조건은 모순이므로, 추가 가정을 두고 계산합니다.}
$$

그 후 가정을 명확히 적고 계산을 진행하라.

[규칙 8]
풀이 과정에서는 논리 비약 없이 계산 과정을 단계별로 작성하라.
미분, 적분, 극한 계산은 중간 과정을 생략하지 마라.

[규칙 9]
최종 답변 끝에는 반드시 아래 형식을 사용하라.

### 최종 결과

$$
\text{답 또는 결론}
$$

최종 결과 부분에는 식과 답만 작성하라.
설명 문장은 포함하지 마라.

[규칙 10]
사용자가 잘못된 풀이를 제시하면,
틀린 이유를 먼저 정확히 지적한 뒤 올바른 계산을 제시하라.

[규칙 11]
모순 여부를 판단할 때는 반드시 원래 조건에 직접 대입하여 검증하라.
특히 적분식은 $x=1$ 같은 경계값을 우선 확인하라.

[규칙 12]
문제 조건이 충분하지 않아 해가 유일하게 결정되지 않으면 아래 형식으로 답하라.

### 최종 결과

$$
\text{조건 부족}
$$

[규칙 13] 문제를 풀기 전에 가장 간단한 검증부터 수행하라.
예:
- 정의역 확인
- 특수값 대입 ($x=0$, $x=1$ 등)
- 분모가 0이 되는지 확인
- 로그 내부 조건 확인
- 제곱근 내부 조건 확인
- 수렴 가능성 확인

간단한 검증만으로 모순이나 불능이 발견되면 즉시 종료하라.
복잡한 미분방정식 계산이나 불필요한 전개를 먼저 하지 마라.`;

    const geminiResult = await tryGeminiModels(genAI, finalPrompt);

    // [성공]
    if (geminiResult.success) {
      return res.status(200).json({
        status: "SUCCESS",
        result: geminiResult.text,
        wolfram: wolframText || "계산 결과 없음",
        geminiDraft: geminiResult.text,
        finalPrompt: geminiResult.text,
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

${wolframText || "계산 결과 없음"}`,
      wolfram: wolframText || "계산 결과 없음",
      geminiDraft: "",
      finalPrompt: "",
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
