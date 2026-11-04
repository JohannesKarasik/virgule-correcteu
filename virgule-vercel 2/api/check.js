// Vercel serverless function: POST /api/check  { text }
// 1. Asks the model for a perfect version of the text (commas only).
// 2. Diffs original vs corrected and returns every place that differs,
//    with character offsets into the ORIGINAL text.
// Response: { corrected, edits: [{ start, end, original, replacement, type, rule, why }] }
// Env: OPENAI_API_KEY (required), OPENAI_MODEL (optional)

const SYSTEM = `Tu es un correcteur spécialisé dans la ponctuation française.
Réécris le texte de l'utilisateur en version PARFAITE du point de vue des virgules : ajoute les virgules manquantes et supprime les virgules fautives.

Contraintes strictes :
- Ne modifie AUCUN autre caractère : ni orthographe, ni accents, ni apostrophes, ni majuscules, ni espaces, ni sauts de ligne, ni autre ponctuation.
- Une virgule ajoutée se colle au mot précédent (« mot, mot »).
- Si une virgule est facultative ou purement stylistique, ne change rien.

Règles principales :
- Virgule après un connecteur ou un complément circonstanciel en tête de phrase (Cependant, Par ailleurs, Hier soir, Quand il est arrivé…).
- Virgule avant mais, car, c'est-à-dire, etc.
- Virgules pour isoler une apposition, une incise, une relative explicative, une apostrophe (« Merci, Marie »).
- Virgule entre les éléments d'une énumération, mais pas avant le « et »/« ou » final.
- Jamais de virgule entre le sujet et le verbe, entre le verbe et son complément d'objet, ni avant une complétive en « que ».

Réponds uniquement en JSON :
{"corrected":"<texte complet corrigé>","changes":[{"type":"insert"|"remove","near":"<3 à 5 mots du texte corrigé autour du changement>","rule":"<nom court de la règle>","explanation":"<une phrase claire en français>"}]}
Liste les changements dans leur ordre d'apparition.`;

/* ---------- Diff: original vs corrected → edits on the original ---------- */
const tokenize = s => s.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|./gsu) || [];

function myers(a, b, maxD = 600) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  const V = new Int32Array(2 * max + 2); const trace = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, off);
    }
  }
  return null; // texts too different
}
function backtrack(trace, n, m, off) {
  let x = n, y = m; const ops = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const V = trace[d], k = x - y;
    const pk = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? k + 1 : k - 1;
    const px = V[off + pk], py = px - pk;
    while (x > px && y > py) { ops.push({ op: '=', a: x - 1, b: y - 1 }); x--; y--; }
    if (d > 0) ops.push(x === px ? { op: '+', a: x, b: y - 1 } : { op: '-', a: x - 1 });
    x = px; y = py;
  }
  return ops.reverse();
}

const strip = s => s.replace(/[,\s]/g, '');
const commas = s => (s.match(/,/g) || []).length;

function diffEdits(orig, corr) {
  const A = tokenize(orig), B = tokenize(corr);
  const pos = [0]; for (const t of A) pos.push(pos[pos.length - 1] + t.length);
  const ops = myers(A, B); if (!ops) return null;
  const edits = []; let cur = null;
  const flush = () => {
    if (!cur) return;
    const original = orig.slice(cur.start, cur.end), replacement = cur.ins.join('');
    if (!(/^\s*$/.test(original) && /^\s*$/.test(replacement))) {   // skip whitespace-only noise
      const type = strip(original) === strip(replacement)
        ? (commas(replacement) > commas(original) ? 'ins' : 'rem') : 'other';
      edits.push({ start: cur.start, end: cur.end, original, replacement, type });
    }
    cur = null;
  };
  for (const o of ops) {
    if (o.op === '=') { flush(); continue; }
    if (!cur) cur = { start: pos[o.a], end: pos[o.a], ins: [] };
    if (o.op === '-') cur.end = pos[o.a + 1]; else cur.ins.push(B[o.b]);
  }
  flush();
  return edits;
}

function attachReasons(edits, changes) {
  const pool = (Array.isArray(changes) ? changes : []).map(c => ({ ...c, used: false }));
  return edits.map(e => {
    const want = e.type === 'ins' ? 'insert' : e.type === 'rem' ? 'remove' : null;
    const c = want && pool.find(p => !p.used && p.type === want); if (c) c.used = true;
    return { ...e,
      rule: (c && c.rule) || (e.type === 'ins' ? 'Virgule attendue' : e.type === 'rem' ? 'Virgule superflue' : 'Modification'),
      why: (c && c.explanation) || (e.type === 'ins' ? 'Une virgule est attendue à cet endroit.' : e.type === 'rem' ? 'Cette virgule n’a pas lieu d’être ici.' : 'Le texte corrigé diffère à cet endroit.') };
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const text = req.body && req.body.text;
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Texte manquant' });
  if (text.length > 8000) return res.status(413).json({ error: 'Texte trop long (8 000 caractères maximum)' });

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
      }),
    });
    if (!r.ok) return res.status(502).json({ error: 'Le service de correction ne répond pas' });
    const data = await r.json();
    const out = JSON.parse(data.choices[0].message.content);
    const corrected = typeof out.corrected === 'string' ? out.corrected : text;
    const edits = diffEdits(text, corrected);
    if (!edits) return res.status(502).json({ error: 'Le texte corrigé est trop différent de l’original' });
    return res.status(200).json({ corrected, edits: attachReasons(edits, out.changes) });
  } catch (e) {
    return res.status(502).json({ error: 'Réponse invalide du service de correction' });
  }
}

export { diffEdits, attachReasons, SYSTEM };
