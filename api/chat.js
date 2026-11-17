const SYSTEM_INSTRUCTION = `אתה עוזר חכם וידידותי בעברית בתוך מערכת "סימולציה".
אתה מנהל שיחה טבעית, ברורה ותמציתית עם המשתמש.

כלל חשוב לגבי ציורים וגרפיקה (SVG):
כאשר המשתמש מבקש לצייר, להמחיש, להציג צורה גאומטרית, תרשים, גרף או כל איור ויזואלי (למשל: "צייר מקבילית", "תראה משולש", "תרשים זרימה"):
1. החזר קוד <svg> תקין, נקי ועצמאי ישירות בתוך התשובה (בלי תגיות <script> ובלי אירועי JavaScript).
2. הגדר תמיד viewBox מתאים (למשל viewBox="0 0 400 260") ורוחב/גובה רספונסיביים (width="100%" height="auto" או ללא width קשיח גדול מדי).
3. השתמש בצבעים ברורים ונעימים לעין, קווים חדים (stroke, stroke-width), וטקסט/תוויות ברורות בעברית אם זה עוזר להמחשה.
4. הסבר בקצרה במשפט או שניים מה ציירת, מעבר לציור עצמו.`;

async function callGeminiModel(model, apiKey, requestBody, timeoutMs) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
        const geminiRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody,
            signal: AbortSignal.timeout(timeoutMs)
        });

        const rawText = await geminiRes.text();
        let data = null;
        try {
            data = rawText ? JSON.parse(rawText) : null;
        } catch {
            data = null;
        }

        if (geminiRes.ok) {
            const reply =
                data?.candidates?.[0]?.content?.parts
                    ?.map((part) => part.text || '')
                    .join('\n')
                    .trim() || 'לא התקבלה תשובה מהמודל.';

            return { ok: true, status: 200, reply, model };
        }

        const status = geminiRes.status || 502;
        const error = data?.error?.message || `המודל ${model} החזיר שגיאה (${status}).`;
        return { ok: false, status, error, model };
    } catch (err) {
        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return {
            ok: false,
            status: isTimeout ? 504 : 502,
            error: isTimeout
                ? `המודל ${model} לא הגיב בזמן (${timeoutMs / 1000} שניות).`
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

async function listModernModels(apiKey, excludeModel) {
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

        return { models: candidates, error: null };
    } catch (err) {
        return { models: [], error: err?.message || 'שגיאה בשליפת רשימת המודלים (ListModels).' };
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

        const requestBody = JSON.stringify({
            systemInstruction: {
                parts: [{ text: SYSTEM_INSTRUCTION }]
            },
            contents,
            generationConfig: {
                temperature: 0.7
            }
        });

        const deadline = Date.now() + 9200;
        const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
        const primaryResult = await callGeminiModel(primaryModel, apiKey, requestBody, 7500);

        if (primaryResult.ok) {
            return res.status(200).json({
                reply: primaryResult.reply,
                model: primaryResult.model
            });
        }

        // Primary model failed: dynamically fetch modern (> 2.5) flash models via ListModels
        const listResult = await listModernModels(apiKey, primaryModel);
        if (listResult.models.length === 0) {
            return res.status(primaryResult.status).json({
                error: `${primaryResult.error} (ולא נמצאו מודלי flash חדשים זמינים ב-ListModels${listResult.error ? `: ${listResult.error}` : ''})`
            });
        }

        let lastResult = primaryResult;
        for (const fallbackModel of listResult.models) {
            const remainingMs = deadline - Date.now();
            if (remainingMs < 1500) {
                break;
            }
            const attemptResult = await callGeminiModel(fallbackModel, apiKey, requestBody, Math.min(remainingMs, 5000));
            if (attemptResult.ok) {
                return res.status(200).json({
                    reply: attemptResult.reply,
                    model: attemptResult.model
                });
            }
            lastResult = attemptResult;
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
