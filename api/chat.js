const SYSTEM_INSTRUCTION = `אתה עוזר חכם וידידותי בעברית בתוך מערכת "סימולציה".
אתה מנהל שיחה טבעית, ברורה ותמציתית עם המשתמש.

כלל חשוב לגבי ציורים וגרפיקה (SVG):
כאשר המשתמש מבקש לצייר, להמחיש, להציג צורה גאומטרית, תרשים, גרף או כל איור ויזואלי (למשל: "צייר מקבילית", "תראה משולש", "תרשים זרימה"):
1. החזר קוד <svg> תקין, נקי ועצמאי ישירות בתוך התשובה (בלי תגיות <script> ובלי אירועי JavaScript).
2. הגדר תמיד viewBox מתאים (למשל viewBox="0 0 400 260") ורוחב/גובה רספונסיביים (width="100%" height="auto" או ללא width קשיח גדול מדי).
3. השתמש בצבעים ברורים ונעימים לעין, קווים חדים (stroke, stroke-width), וטקסט/תוויות ברורות בעברית אם זה עוזר להמחשה.
4. הסבר בקצרה במשפט או שניים מה ציירת, מעבר לציור עצמו.`;

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

    try {
        const res = await fetch(listEndpoint, {
            method: 'GET',
            signal: AbortSignal.timeout(3000)
        });

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
        return { models: [], error: err?.message || 'שגיאה בשליפת רשימת המודלים (ListModels).' };
    }
}

async function pipeGeminiSseToClient(geminiRes, model, res, meta = {}) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
    });

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let latestUsage = null;

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
                        res.write(`data: ${JSON.stringify({ text })}\n\n`);
                    }
                } catch {
                    // Ignore partial or non-JSON keepalive lines
                }
            }
        }

        res.write(`data: ${JSON.stringify({
            done: true,
            model,
            speedMode: meta.speedMode || 'fast',
            thinkingApplied: Boolean(meta.thinkingApplied),
            usage: latestUsage
        })}\n\n`);
    } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err?.message || 'הזרמת התשובה נקטעה.' })}\n\n`);
    } finally {
        res.end();
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: 'מפתח GEMINI_API_KEY חסר בהגדרות Vercel (Environment Variables).'
        });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const messages = Array.isArray(body.messages) ? body.messages : [];

        if (messages.length === 0) {
            return res.status(400).json({ error: 'לא התקבלו הודעות.' });
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

        const speedMode = SPEED_CONFIGS[body.speedMode] ? body.speedMode : 'fast';
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

        const deadline = Date.now() + 9200;
        const primaryTimeoutMs = speedMode === 'accurate' ? 8000 : 6500;
        const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
        const primaryResult = await tryOpenWithSpeed(primaryModel, primaryTimeoutMs);

        if (primaryResult.ok) {
            return await pipeGeminiSseToClient(primaryResult.response, primaryResult.model, res, {
                speedMode,
                thinkingApplied: primaryResult.thinkingApplied
            });
        }

        // Primary failed: try gemini-3.1-flash-lite-preview next with remaining time budget
        const secondaryModel = 'gemini-3.1-flash-lite-preview';
        let lastResult = primaryResult;
        const remainingForSecondary = deadline - Date.now();
        if (secondaryModel !== primaryModel && remainingForSecondary >= 2000) {
            const secondaryResult = await tryOpenWithSpeed(secondaryModel, Math.min(remainingForSecondary, 4500));
            if (secondaryResult.ok) {
                return await pipeGeminiSseToClient(secondaryResult.response, secondaryResult.model, res, {
                    speedMode,
                    thinkingApplied: secondaryResult.thinkingApplied
                });
            }
            lastResult = secondaryResult;
        }

        // Last resort: fetch remaining modern (> 2.5) flash models via ListModels if time remains
        if (deadline - Date.now() >= 2500) {
            const listResult = await listModernModels(apiKey, primaryModel);
            const remainingModels = listResult.models.filter((m) => m !== secondaryModel);

            for (const fallbackModel of remainingModels) {
                const remainingMs = deadline - Date.now();
                if (remainingMs < 2000) break;
                const attempt = await tryOpenWithSpeed(fallbackModel, Math.min(remainingMs, 3500));
                if (attempt.ok) {
                    return await pipeGeminiSseToClient(attempt.response, attempt.model, res, {
                        speedMode,
                        thinkingApplied: attempt.thinkingApplied
                    });
                }
                lastResult = attempt;
            }
        }

        return res.status(lastResult.status).json({
            error: `${lastResult.error} (ניסיון קודם מול ${primaryModel}: ${primaryResult.error})`
        });
    } catch (err) {
        return res.status(500).json({
            error: 'אירעה שגיאה בשרת בעת עיבוד הבקשה.',
            details: err?.message || String(err)
        });
    }
};
