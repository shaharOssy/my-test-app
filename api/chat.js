const SYSTEM_INSTRUCTION = `אתה עוזר חכם וידידותי בעברית בתוך מערכת "סימולציה".
אתה מנהל שיחה טבעית, ברורה ותמציתית עם המשתמש.

כלל חשוב לגבי ציורים וגרפיקה (SVG):
כאשר המשתמש מבקש לצייר, להמחיש, להציג צורה גאומטרית, תרשים, גרף או כל איור ויזואלי (למשל: "צייר מקבילית", "תראה משולש", "תרשים זרימה"):
1. החזר קוד <svg> תקין, נקי ועצמאי ישירות בתוך התשובה (בלי תגיות <script> ובלי אירועי JavaScript).
2. הגדר תמיד viewBox מתאים (למשל viewBox="0 0 400 260") ורוחב/גובה רספונסיביים (width="100%" height="auto" או ללא width קשיח גדול מדי).
3. השתמש בצבעים ברורים ונעימים לעין, קווים חדים (stroke, stroke-width), וטקסט/תוויות ברורות בעברית אם זה עוזר להמחשה.
4. הסבר בקצרה במשפט או שניים מה ציירת, מעבר לציור עצמו.`;

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

        const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const geminiRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: SYSTEM_INSTRUCTION }]
                },
                contents,
                generationConfig: {
                    temperature: 0.7
                }
            })
        });

        const data = await geminiRes.json();

        if (!geminiRes.ok) {
            const errMsg = data?.error?.message || 'שגיאה בפנייה למודל ה-AI.';
            return res.status(geminiRes.status).json({ error: errMsg });
        }

        const reply =
            data?.candidates?.[0]?.content?.parts
                ?.map((part) => part.text || '')
                .join('\n')
                .trim() || 'לא התקבלה תשובה מהמודל.';

        return res.status(200).json({ reply });
    } catch (err) {
        return res.status(500).json({
            error: 'אירעה שגיאה בשרת בעת עיבוד הבקשה.',
            details: err?.message || String(err)
        });
    }
};
