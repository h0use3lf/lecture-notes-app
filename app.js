import { FFmpeg } from "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js";

const BASE_URL = "https://factchat-cloud.mindlogic.ai/v1/gateway";
const CLAUDE_MODEL = "claude-sonnet-5";
const AUDIO_MODEL = "gemini-3.5-flash"; // 오디오 인식 지원 여부 미검증 - 1단계 테스트 대상
const TARGET_SAMPLE_RATE = 16000;
const SEGMENT_SECONDS = 8 * 60; // 25MB 요청 제한 기준, 16kHz mono WAV로 재인코딩 시 여유있게 들어가는 길이

const el = (id) => document.getElementById(id);
const logEl = el("log");

function log(msg) {
  const time = new Date().toLocaleTimeString("ko-KR");
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function getApiKey() {
  return localStorage.getItem("nova_api_key") || "";
}

el("apiKey").value = getApiKey();

el("saveKeyBtn").addEventListener("click", () => {
  localStorage.setItem("nova_api_key", el("apiKey").value.trim());
  el("keyStatus").textContent = "저장됨";
  setTimeout(() => (el("keyStatus").textContent = ""), 1500);
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function callClaude(messages, maxTokens = 4096) {
  const res = await fetch(`${BASE_URL}/claude/v1/messages/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": getApiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude 호출 실패 (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.content.map((b) => b.text || "").join("\n");
}

async function callChatCompletions(model, messages, maxTokens = 2048) {
  const res = await fetch(`${BASE_URL}/chat/completions/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${model} 호출 실패 (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

async function extractPdfContentOne(file, index, total) {
  log(`[${index + 1}/${total}] PDF 처리 중: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
  if (file.size > 18 * 1024 * 1024) {
    log(`경고: ${file.name}이 커서 25MB 요청 제한을 넘길 수 있습니다.`);
  }
  const base64 = await fileToBase64(file);
  const text = await callClaude([
    {
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        },
        {
          type: "text",
          text: "이 강의자료 PDF의 내용을 슬라이드/페이지 순서대로 빠짐없이 텍스트로 옮겨줘. 표나 다이어그램은 핵심 내용을 문장으로 풀어서 설명해줘. 별도의 요약이나 평가 없이 원문 내용 추출에만 집중해줘.",
        },
      ],
    },
  ], 8192);
  log(`[${index + 1}/${total}] PDF 처리 완료: ${file.name}`);
  return text;
}

async function extractPdfContent(fileList) {
  const files = Array.from(fileList).sort((a, b) => a.name.localeCompare(b.name));
  let combined = "";
  for (let i = 0; i < files.length; i++) {
    const text = await extractPdfContentOne(files[i], i, files.length);
    combined += `\n\n[파일: ${files[i].name}]\n${text}`;
  }
  return combined.trim();
}

// WAV 인코딩: 게이트웨이가 요구하는 정확한 오디오 스키마가 미검증이라
// 가장 보편적인 16bit PCM WAV + OpenAI 스타일 input_audio 블록으로 시도한다.
function encodeWav(audioBuffer) {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.getChannelData(0);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function decodeAndResample(file) {
  const arrayBuf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(arrayBuf);

  if (decoded.sampleRate === TARGET_SAMPLE_RATE) return decoded;

  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * TARGET_SAMPLE_RATE),
    TARGET_SAMPLE_RATE
  );
  const src = offlineCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offlineCtx.destination);
  src.start();
  return await offlineCtx.startRendering();
}

async function transcribeAudioFile(file, index, total) {
  log(`[${index + 1}/${total}] ${file.name} 디코딩 중...`);
  const decoded = await decodeAndResample(file);
  const wav = encodeWav(decoded);
  const sizeMb = wav.byteLength / 1024 / 1024;
  if (sizeMb > 18) {
    log(`경고: ${file.name} 인코딩 후 ${sizeMb.toFixed(1)}MB — 25MB 요청 제한에 걸릴 수 있습니다. 더 짧게 잘라주세요.`);
  }
  const base64 = arrayBufferToBase64(wav);

  log(`[${index + 1}/${total}] ${file.name} 전사 요청 중... (${(decoded.duration / 60).toFixed(1)}분)`);
  const text = await callChatCompletions(AUDIO_MODEL, [
    {
      role: "user",
      content: [
        { type: "text", text: "다음 오디오를 한국어로 정확하게 받아써줘. 발화 내용만 출력하고 다른 설명은 붙이지 마." },
        { type: "input_audio", input_audio: { data: base64, format: "wav" } },
      ],
    },
  ]);
  log(`[${index + 1}/${total}] ${file.name} 완료`);
  return text;
}

let ffmpegInstance = null;

async function getFfmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  log("오디오 분할 엔진(ffmpeg.wasm) 로딩 중... (최초 1회, 약 30MB 다운로드)");
  const ffmpeg = new FFmpeg();
  const coreBaseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
  const ffmpegBaseURL = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm";

  // worker.js를 same-origin blob으로 감싸 로드한다. 내부의 상대경로 import
  // ("./const.js", "./errors.js")는 CDN 절대경로로 치환해 blob 안에서도
  // 정상 해석되게 한다.
  const workerText = await (await fetch(`${ffmpegBaseURL}/worker.js`)).text();
  const patchedWorker = workerText
    .replace('from "./const.js"', `from "${ffmpegBaseURL}/const.js"`)
    .replace('from "./errors.js"', `from "${ffmpegBaseURL}/errors.js"`);
  const classWorkerURL = URL.createObjectURL(new Blob([patchedWorker], { type: "text/javascript" }));

  await ffmpeg.load({
    coreURL: await toBlobURL(`${coreBaseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${coreBaseURL}/ffmpeg-core.wasm`, "application/wasm"),
    classWorkerURL,
  });
  ffmpegInstance = ffmpeg;
  log("ffmpeg 로딩 완료");
  return ffmpeg;
}

// 원본을 재인코딩하지 않고(-c copy) 구간만 잘라 컨테이너를 다시 감싸므로 빠르고
// 브라우저 메모리도 원본 압축 파일 크기 수준으로만 사용한다 (PCM 전체 디코딩 없음).
async function splitAudio(file) {
  const ffmpeg = await getFfmpeg();
  const ext = (file.name.split(".").pop() || "mp3").toLowerCase();
  const inputName = `input.${ext}`;
  const outPattern = `chunk_%03d.${ext}`;

  await ffmpeg.writeFile(inputName, await fetchFile(file));
  log(`${file.name} 분할 중 (구간당 ${SEGMENT_SECONDS / 60}분)...`);
  await ffmpeg.exec([
    "-i", inputName,
    "-f", "segment",
    "-segment_time", String(SEGMENT_SECONDS),
    "-c", "copy",
    "-reset_timestamps", "1",
    outPattern,
  ]);

  const dir = await ffmpeg.listDir("/");
  const chunkNames = dir
    .map((e) => e.name)
    .filter((name) => name.startsWith("chunk_") && name.endsWith(`.${ext}`))
    .sort();

  const chunks = [];
  for (const name of chunkNames) {
    const data = await ffmpeg.readFile(name);
    chunks.push(new File([data.buffer], `${file.name}-${name}`, { type: file.type || "audio/mpeg" }));
    await ffmpeg.deleteFile(name);
  }
  await ffmpeg.deleteFile(inputName);
  log(`${file.name} → ${chunks.length}개 구간으로 분할 완료`);
  return chunks;
}

async function transcribeAudio(fileList) {
  const files = Array.from(fileList).sort((a, b) => a.name.localeCompare(b.name));

  let allChunks = [];
  for (const file of files) {
    const chunks = await splitAudio(file);
    allChunks = allChunks.concat(chunks);
  }

  let transcript = "";
  for (let i = 0; i < allChunks.length; i++) {
    const text = await transcribeAudioFile(allChunks[i], i, allChunks.length);
    transcript += `\n\n[구간 ${i + 1}/${allChunks.length}]\n${text}`;
  }
  return transcript.trim();
}

async function generateNotes(pdfText, transcriptText) {
  log("최종 강의노트 생성 중...");
  const parts = [];
  if (pdfText) parts.push(`--- 강의자료(PDF) 내용 ---\n${pdfText}`);
  if (transcriptText) parts.push(`--- 강의 녹음 전사 ---\n${transcriptText}`);

  const notes = await callClaude([
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "아래는 강의자료 내용과 강의 녹음 전사 내용이야. 이 둘을 종합해서 학생이 복습하기 좋은 강의노트를 한국어 마크다운으로 작성해줘.\n" +
            "구성: 1) 강의 주제/개요, 2) 목차별 핵심 개념 정리 (## 대분류, ### 중분류, #### 소분류 제목 계층 사용), 3) 중요 정의/공식/예시, 4) 강조되었던 내용이나 시험에 나올법한 포인트, 5) 요약.\n" +
            "강의자료와 녹음 내용이 겹치면 통합하고, 녹음에만 있는 설명(강사의 부연 설명 등)도 놓치지 말고 반영해줘.\n\n" +
            "마크다운 작성 규칙:\n" +
            "- 강사가 슬라이드에 없이 구두로만 설명한 내용은 전부 `> 실 강의 내용: ...` 형태의 인용문(blockquote)으로 표기해줘. " +
            "\"강사 부연\", \"강사 팁\", \"강사 예시\" 같은 표현을 쓰지 말고 반드시 \"실 강의 내용\"으로 통일해줘.\n" +
            "- 시험에 나올 만한 핵심 강조 포인트는 `> ⚠️ 핵심 강조점: ...` 형태의 인용문으로 표기해줘.\n" +
            "- 숫자 범위를 나타내는 물결표(~)는 앞뒤에 공백을 넣어서 써줘 (예: \"6 ~ 45%\"). 공백 없이 붙여 쓰면 마크다운 취소선으로 잘못 인식될 수 있어.\n\n" +
            parts.join("\n\n"),
        },
      ],
    },
  ], 8192);
  log("강의노트 생성 완료");
  return notes;
}

el("runBtn").addEventListener("click", async () => {
  logEl.textContent = "";
  el("resultCard").hidden = true;

  if (!getApiKey()) {
    log("오류: API 키를 먼저 저장해주세요.");
    return;
  }

  const pdfFiles = el("pdfInput").files;
  const audioFiles = el("audioInput").files;

  if (pdfFiles.length === 0 && audioFiles.length === 0) {
    log("오류: PDF 또는 오디오 파일을 하나 이상 선택해주세요.");
    return;
  }

  el("runBtn").disabled = true;
  try {
    let pdfText = "";
    let transcript = "";

    if (pdfFiles.length > 0) pdfText = await extractPdfContent(pdfFiles);
    if (audioFiles.length > 0) transcript = await transcribeAudio(audioFiles);

    const notes = await generateNotes(pdfText, transcript);

    el("resultText").value = notes;
    el("resultCard").hidden = false;
  } catch (err) {
    log(`오류 발생: ${err.message}`);
    console.error(err);
  } finally {
    el("runBtn").disabled = false;
  }
});

el("copyBtn").addEventListener("click", () => {
  el("resultText").select();
  document.execCommand("copy");
});

el("downloadBtn").addEventListener("click", () => {
  const blob = new Blob([el("resultText").value], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "lecture-notes.md";
  a.click();
  URL.revokeObjectURL(url);
});

function classifyBlockquotes(root) {
  root.querySelectorAll("blockquote").forEach((bq) => {
    const text = bq.textContent;
    if (text.includes("실 강의 내용")) bq.classList.add("lecture-note");
    else if (text.includes("핵심 강조점") || text.includes("⚠")) bq.classList.add("key-emphasis");
  });
}

// 대(h2)/중(h3)/소(h4) 분류 단위로 <section>을 중첩시켜 감싼다. 각 section은
// CSS에서 break-inside: avoid-page가 걸려 있어, PDF 인쇄 시 한 페이지에
// 다 들어가지 않는 분류 단위는 통째로 다음 페이지로 넘어간다.
function sectionize(root) {
  function build(nodes, level) {
    if (level > 4) return nodes;
    const tagName = "H" + level;
    const result = [];
    let current = null;
    for (const node of nodes) {
      const isThisLevel = node.nodeType === 1 && node.tagName === tagName;
      const isShallower = node.nodeType === 1 && /^H[1-9]$/.test(node.tagName) && Number(node.tagName[1]) < level;
      if (isThisLevel) {
        if (current) result.push(current);
        current = document.createElement("section");
        current.className = "sec-h" + level;
        current.appendChild(node);
      } else if (isShallower) {
        if (current) { result.push(current); current = null; }
        result.push(node);
      } else if (current) {
        current.appendChild(node);
      } else {
        result.push(node);
      }
    }
    if (current) result.push(current);
    return result.map((n) => {
      if (n.nodeType === 1 && n.tagName === "SECTION") {
        const children = Array.from(n.childNodes);
        const nested = build(children, level + 1);
        n.innerHTML = "";
        nested.forEach((c) => n.appendChild(c));
      }
      return n;
    });
  }
  const sectioned = build(Array.from(root.childNodes), 2);
  root.innerHTML = "";
  sectioned.forEach((n) => root.appendChild(n));
}

el("pdfBtn").addEventListener("click", () => {
  const md = el("resultText").value;
  if (!md) return;
  const printArea = el("printArea");
  printArea.innerHTML = marked.parse(md);
  classifyBlockquotes(printArea);
  sectionize(printArea);
  window.print();
});
