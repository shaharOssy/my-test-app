export const config = {
    runtime: 'edge'
};

const SYSTEM_INSTRUCTION = `אתה עוזר חכם וידידותי בעברית בתוך מערכת "סימולציה".
אתה מנהל שיחה טבעית, ברורה ותמציתית עם המשתמש.

כלל חשוב לגבי ציורים וגרפיקה (SVG):
כאשר המשתמש מבקש לצייר, להמחיש, להציג צורה גאומטרית, תרשים, גרף או כל איור ויזואלי (למשל: "צייר מקבילית", "תוסיף משולש", "תרשים זרימה"):
1. החזר קוד <svg> תקין, קצר, נקי ועצמאי ישירות בתוך התשובה (בלי תגיות <script> ובלי אירועי JavaScript).
2. הלוח המרכזי באפליקציה הוא מצטבר ושקוף — לכן:
   - אל תוסיף מלבן רקע כהה/אטום (<rect> לרקע), צייר על רקע שקוף שיראה טוב על לוח בהיר.
   - אם המשתמש מבקש להוסיף צורה חדשה (למשל "תוסיף משולש"), צייר **רק את הצורה החדשה בלבד** ואל תצייר שוב צורות מהודעות קודמות!
3. הגדר viewBox מתאים (למשל viewBox="0 0 320 220") ורוחב/גובה רספונסיביים (width="100%" height="auto").
4. השתמש בצבעים ברורים המתאימים ללוח בהיר (כגון #2563eb, #c84b31, #16a34a, #7c3aed), קווים חדים (stroke, stroke-width="3"), מילוי עדין (fill-opacity="0.18") ותוויות ברורות בעברית.
5. הסבר בקצרה במשפט או שניים מה ציירת, מעבר לציור עצמו.`;

function jsonResponse(payload, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...extraHeaders
        }
    });
}

async function openGeminiStream(model, apiKey, requestBody, connectTimeoutMs) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('CONNECT_TIMEOUT')), connectTimeoutMs);

    try {
        const geminiRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody,
            signal: controller.signal
        });
        // Cancel connection timeout once response headers arrive so active streaming is never aborted mid-reply
        clearTimeout(timer);

        if (geminiRes.ok && geminiRes.body) {
            return { ok: true, status: 200, response: geminiRes, model };
        }

        const rawText = await geminiRes.text();
        let data = null;
        try {
            data = rawText ? JSON.parse(rawText) : null;
        } catch {
            data = null;
        }

        const status = geminiRes.status || 502;
        const error = data?.error?.message || `המודל ${model} החזיר שגיאה (${status}).`;
        return { ok: false, status, error, model };
    } catch (err) {
        clearTimeout(timer);
        const isTimeout = err?.message === 'CONNECT_TIMEOUT' || err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return {
            ok: false,
            status: isTimeout ? 504 : 502,
            error: isTimeout
                ? `המודל ${model} לא התחיל להגיב בזמן (${(connectTimeoutMs / 1000).toFixed(1)} שניות).`
                : (err?.message || `שגיאת תקשורת מול המודל ${model}.`),
            model
        };
    }
}

function getModernGeminiVersion(modelId) {
    const match = modelId.match(/^gemini-(\d+(?:\.\d+)?)/i);
    if (!match) return null;
    const version = parseFloat(match[1]);
    return Number.isFinite(version) && version > 2.5 ? version : null;
}

let cachedModels = null;
let cachedModelsAt = 0;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

async function listModernModels(apiKey, excludeModel) {
    if (cachedModels && Date.now() - cachedModelsAt < MODELS_CACHE_TTL_MS) {
        return { models: cachedModels.filter((id) => id !== excludeModel), error: null };
    }

    const listEndpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);

    try {
        const res = await fetch(listEndpoint, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timer);

        const rawText = await res.text();
        const data = rawText ? JSON.parse(rawText) : null;
        if (!res.ok || !Array.isArray(data?.models)) {
            return { models: [], error: data?.error?.message || `ListModels החזיר שגיאה (${res.status}).` };
        }

        const candidates = data.models
            .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map((m) => (m.name || '').replace(/^models\//, ''))
            .filter((id) => {
                if (!id || id === excludeModel) return false;
                const version = getModernGeminiVersion(id);
                if (version === null) return false;
                const lower = id.toLowerCase();
                if (!lower.includes('flash')) return false;
                return (
                    !lower.includes('argon') &&
                    !lower.includes('pro') &&
                    !lower.includes('ultra') &&
                    !lower.includes('exp') &&
                    !lower.includes('tts') &&
                    !lower.includes('image') &&
                    !lower.includes('robotics')
                );
            })
            .sort((a, b) => {
                const verDiff = (getModernGeminiVersion(b) || 0) - (getModernGeminiVersion(a) || 0);
                if (verDiff !== 0) return verDiff;
                const aLite = a.toLowerCase().includes('lite') ? 1 : 0;
                const bLite = b.toLowerCase().includes('lite') ? 1 : 0;
                return aLite - bLite;
            });

        cachedModels = candidates;
        cachedModelsAt = Date.now();
        return { models: candidates.filter((id) => id !== excludeModel), error: null };
    } catch (err) {
        clearTimeout(timer);
        return { models: [], error: err?.message || 'שגיאה בשליפת רשימת המודלים (ListModels).' };
    }
}

function createSseResponse(geminiRes, model, meta = {}) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8');
    const reader = geminiRes.body.getReader();

    const stream = new ReadableStream({
        async start(controller) {
            let buffer = '';
            let latestUsage = null;

            const enqueueEvent = (obj) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };

            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const rawLine of lines) {
                        const line = rawLine.trim();
                        if (!line.startsWith('data:')) continue;
                        const payloadStr = line.slice(5).trim();
                        if (!payloadStr || payloadStr === '[DONE]') continue;

                        try {
                            const chunk = JSON.parse(payloadStr);
                            if (chunk?.usageMetadata) {
                                latestUsage = chunk.usageMetadata;
                            }
                            const text = chunk?.candidates?.[0]?.content?.parts
                                ?.map((part) => part.text || '')
                                .join('');
                            if (text) {
                                enqueueEvent({ text });
                            }
                        } catch {
                            // Ignore partial or non-JSON keepalive lines
                        }
                    }
                }

                enqueueEvent({
                    done: true,
                    model,
                    speedMode: meta.speedMode || 'fast',
                    thinkingApplied: Boolean(meta.thinkingApplied),
                    usage: latestUsage
                });
            } catch (err) {
                enqueueEvent({ error: err?.message || 'הזרמת התשובה נקטעה.' });
            } finally {
                controller.close();
            }
        }
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform'
        }
    });
}

export default async function handler(req) {
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return jsonResponse({
            error: 'מפתח GEMINI_API_KEY חסר בהגדרות Vercel (Environment Variables).'
        }, 500);
    }

    try {
        const body = await req.json().catch(() => ({}));
        const messages = Array.isArray(body?.messages) ? body.messages : [];

        if (messages.length === 0) {
            return jsonResponse({ error: 'לא התקבלו הודעות.' }, 400);
        }

        // Convert chat history to Gemini's contents format
        const contents = messages
            .filter((msg) => msg && typeof msg.text === 'string' && msg.text.trim())
            .slice(-20)
            .map((msg) => ({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.text }]
            }));

        const SPEED_CONFIGS = {
            fast: {
                thinkingBudget: 0,
                instruction: 'מצב תגובה: מהיר — ענה בקצרה, בצורה תמציתית, ישירה וממוקדת.'
            },
            balanced: {
                thinkingBudget: 1024,
                instruction: 'מצב תגובה: בינוני — ענה בצורה מאוזנת, ברורה ומסודרת.'
            },
            accurate: {
                thinkingBudget: 8192,
                instruction: 'מצב תגובה: מדויק — חשוב לעומק ותן תשובה מקיפה, מדויקת ומפורטת.'
            }
        };

        const speedMode = SPEED_CONFIGS[body?.speedMode] ? body.speedMode : 'fast';
        const speedCfg = SPEED_CONFIGS[speedMode];

        const buildRequestBody = (includeThinkingConfig) => JSON.stringify({
            systemInstruction: {
                parts: [{ text: `${SYSTEM_INSTRUCTION}\n\n${speedCfg.instruction}` }]
            },
            contents,
            generationConfig: {
                temperature: 0.7,
                ...(includeThinkingConfig ? { thinkingConfig: { thinkingBudget: speedCfg.thinkingBudget } } : {})
            }
        });

        const tryOpenWithSpeed = async (model, timeoutMs) => {
            const firstTry = await openGeminiStream(model, apiKey, buildRequestBody(true), timeoutMs);
            if (firstTry.ok) {
                return { ...firstTry, thinkingApplied: true };
            }
            // If this model rejects thinkingConfig (400), retry the SAME model without thinkingConfig
            if (firstTry.status === 400) {
                const retry = await openGeminiStream(model, apiKey, buildRequestBody(false), timeoutMs);
                return { ...retry, thinkingApplied: false };
            }
            return { ...firstTry, thinkingApplied: false };
        };

        // Edge Functions allow up to 25s for initial response
        const deadline = Date.now() + 23000;
        const primaryTimeoutMs = speedMode === 'accurate' ? 15000 : 10000;
        const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
        const primaryResult = await tryOpenWithSpeed(primaryModel, primaryTimeoutMs);

        if (primaryResult.ok) {
            return createSseResponse(primaryResult.response, primaryResult.model, {
                speedMode,
                thinkingApplied: primaryResult.thinkingApplied
            });
        }

        // Primary failed: try gemini-3.1-flash-lite-preview next with remaining Edge budget
        const secondaryModel = 'gemini-3.1-flash-lite-preview';
        let lastResult = primaryResult;
        const remainingForSecondary = deadline - Date.now();
        if (secondaryModel !== primaryModel && remainingForSecondary >= 3000) {
            const secondaryResult = await tryOpenWithSpeed(secondaryModel, Math.min(remainingForSecondary, 7000));
            if (secondaryResult.ok) {
                return createSseResponse(secondaryResult.response, secondaryResult.model, {
                    speedMode,
                    thinkingApplied: secondaryResult.thinkingApplied
                });
            }
            lastResult = secondaryResult;
        }

        // Last resort: fetch remaining modern (> 2.5) flash models via ListModels if time remains
        if (deadline - Date.now() >= 3000) {
            const listResult = await listModernModels(apiKey, primaryModel);
            const remainingModels = listResult.models.filter((m) => m !== secondaryModel);

            for (const fallbackModel of remainingModels) {
                const remainingMs = deadline - Date.now();
                if (remainingMs < 2500) break;
                const attempt = await tryOpenWithSpeed(fallbackModel, Math.min(remainingMs, 5000));
                if (attempt.ok) {
                    return createSseResponse(attempt.response, attempt.model, {
                        speedMode,
                        thinkingApplied: attempt.thinkingApplied
                    });
                }
                lastResult = attempt;
            }
        }

        return jsonResponse({
            error: `${lastResult.error} (ניסיון קודם מול ${primaryModel}: ${primaryResult.error})`
        }, lastResult.status);
    } catch (err) {
        return jsonResponse({
            error: 'אירעה שגיאה בשרת בעת עיבוד הבקשה.',
            details: err?.message || String(err)
        }, 500);
    }
}
