// memory.js — pure raw fetch, no supabase-js dependency
// Consistent with companion-drift.js pattern. No WebSocket, no Node version coupling.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const sbHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status}`);
  return res.json();
}

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${res.status}`);
  return res.json();
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  return res.status;
}

async function sbDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: sbHeaders
  });
  return res.status;
}

async function sbUpsert(table, body, onConflict) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} failed: ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { action, userId, companionId, data, type, limit = 50 } = JSON.parse(event.body || '{}');

    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'userId required' }) };
    }

    // GET: Fetch memory/context for a companion
    if (action === 'get') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };
      const typeFilter = type ? `&type=eq.${type}` : '';
      const memories = await sbGet(`memories?companion_id=eq.${companionId}&user_id=eq.${userId}${typeFilter}&order=created_at.desc&limit=${limit}`);
      return { statusCode: 200, headers, body: JSON.stringify({ memories: memories || [] }) };
    }

    // GET_SESSIONS: Returns distinct session list (metadata only, no content) for Past Rooms panel.
    // Fetches all message rows server-side, deduplicates by session_id, returns one entry per session.
    // This bypasses the 200-message limit that was cutting off older sessions.
    if (action === 'get_sessions') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };
      const rows = await sbGet(`memories?companion_id=eq.${encodeURIComponent(companionId)}&user_id=eq.${encodeURIComponent(userId)}&type=eq.message&select=id,created_at,metadata&order=created_at.desc&limit=5000`);
      if (!Array.isArray(rows)) return { statusCode: 200, headers, body: JSON.stringify({ sessions: [] }) };
      const sessions = {};
      for (const r of rows) {
        const sid = r.metadata?.session_id || 'legacy';
        if (!sessions[sid]) {
          sessions[sid] = { session_id: sid, created_at: r.created_at, room: r.metadata?.room || '', message_count: 0 };
        } else {
          // Keep the earliest created_at as session start time
          if (new Date(r.created_at) < new Date(sessions[sid].created_at)) {
            sessions[sid].created_at = r.created_at;
          }
        }
        sessions[sid].message_count++;
      }
      const sessionList = Object.values(sessions).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { statusCode: 200, headers, body: JSON.stringify({ sessions: sessionList }) };
    }

    // GET_SESSION: Returns full messages for a specific session_id (on-demand, for Past Rooms click).
    if (action === 'get_session') {
      const sessionId = data?.sessionId || JSON.parse(event.body || '{}').sessionId;
      if (!companionId || !sessionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId and sessionId required' }) };
      let memories;
      if (sessionId === 'legacy') {
        // Legacy rows have no session_id — fetch messages that lack a session_id in metadata
        // PostgREST can't easily filter by missing JSON key, so fetch all and filter server-side
        const all = await sbGet(`memories?companion_id=eq.${encodeURIComponent(companionId)}&user_id=eq.${encodeURIComponent(userId)}&type=eq.message&order=created_at.asc&limit=2000`);
        memories = (all || []).filter(r => !r.metadata?.session_id);
      } else {
        memories = await sbGet(`memories?companion_id=eq.${encodeURIComponent(companionId)}&user_id=eq.${encodeURIComponent(userId)}&type=eq.message&metadata->>session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc`);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ memories: memories || [] }) };
    }

    // POST: Save a memory/message
    if (action === 'save') {
      if (!companionId || !type) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId and type required' }) };

      // SUMMARY PROTECTION: Reject weak summaries that would replace a richer one
      if (type === 'summary') {
        const newContent = data.content || '';
        const newWordCount = newContent.split(' ').length;
        try {
          const existing = await sbGet(`memories?companion_id=eq.${companionId}&user_id=eq.${userId}&type=eq.summary&order=created_at.desc&limit=1&select=content,metadata`);
          const prev = existing?.[0];
          if (prev) {
            const prevWordCount = prev.content.split(' ').length;
            const prevProtected = prev.metadata?.protected === true;
            // Reject if: previous is protected master summary, OR new is >40% shorter than previous
            if (prevProtected && newWordCount < prevWordCount * 0.7) {
              console.log(`[SUMMARY PROTECTION] Rejected weak summary (${newWordCount}w vs ${prevWordCount}w protected)`);
              return { statusCode: 200, headers, body: JSON.stringify({ protected: true, skipped: true, reason: 'protected_summary_would_be_replaced' }) };
            }
            if (!prevProtected && newWordCount < prevWordCount * 0.5) {
              console.log(`[SUMMARY PROTECTION] Rejected thin summary (${newWordCount}w vs ${prevWordCount}w)`);
              return { statusCode: 200, headers, body: JSON.stringify({ protected: true, skipped: true, reason: 'summary_too_thin' }) };
            }
          }
        } catch(e) { /* first summary ever, allow it */ }
      }

      const memory = await sbPost('memories', {
        companion_id: companionId,
        user_id: userId,
        type,
        content: data.content || '',
        metadata: data.metadata || {}
      });
      return { statusCode: 201, headers, body: JSON.stringify({ memory: memory[0] }) };
    }

    // RECOVER_SESSION: Look up user_id or companion_id from memories for session recovery (replaces anon direct reads)
    if (action === 'recover_session') {
      // Recover user_id by companion_id
      if (companionId && !userId) {
        const rows = await sbGet(`memories?companion_id=eq.${companionId}&type=eq.message&select=user_id&limit=1&order=created_at.desc`);
        return { statusCode: 200, headers, body: JSON.stringify({ user_id: rows[0]?.user_id || null }) };
      }
      // Recover companion_id by user_id
      if (userId && !companionId) {
        const rows = await sbGet(`memories?user_id=eq.${userId}&type=eq.message&select=companion_id&order=created_at.desc&limit=200`);
        return { statusCode: 200, headers, body: JSON.stringify({ rows: rows || [] }) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId or userId required' }) };
    }

    // GET_COMPANION: Fetch companion personality
    if (action === 'get_companion') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };
      const rows = await sbGet(`companions?id=eq.${companionId}&user_id=eq.${userId}&limit=1`);
      return { statusCode: 200, headers, body: JSON.stringify({ companion: rows[0] || null }) };
    }

    // SAVE_COMPANION: Save companion personality
    if (action === 'save_companion') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };
      await sbPatch(`companions?id=eq.${companionId}&user_id=eq.${userId}`, {
        personality: data.personality || {},
        name: data.name || 'Unnamed',
        updated_at: new Date().toISOString()
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // DELETE: Remove a memory
    if (action === 'delete') {
      const { memoryId } = data;
      if (!memoryId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'memoryId required' }) };
      await sbDelete(`memories?id=eq.${memoryId}&user_id=eq.${userId}`);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // CATCHUP_SUMMARIZE: Session-start catch-up summarizer with watermark
    // Fires async on session start. Finds messages newer than last_summarized_at,
    // compresses them, advances watermark only after successful write.
    if (action === 'catchup_summarize') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };

      // Fetch current watermark — silent fail if column doesn't exist yet
      let watermark = null;
      try {
        const stateRows = await sbGet(`companion_states?companion_id=eq.${companionId}&user_id=eq.${userId}&select=last_summarized_at&limit=1`);
        watermark = stateRows?.[0]?.last_summarized_at || null;
      } catch (e) { /* cold start */ }

      // Fetch messages — cold start: last 50 desc, normal: newer than watermark asc
      let msgs;
      if (watermark) {
        msgs = await sbGet(`memories?companion_id=eq.${companionId}&user_id=eq.${userId}&type=eq.message&created_at=gt.${encodeURIComponent(watermark)}&order=created_at.asc&select=id,content,metadata,created_at`);
      } else {
        const raw = await sbGet(`memories?companion_id=eq.${companionId}&user_id=eq.${userId}&type=eq.message&order=created_at.desc&limit=50&select=id,content,metadata,created_at`);
        msgs = Array.isArray(raw) ? [...raw].reverse() : [];
      }

      // Threshold gate
      const THRESHOLD = 5;
      if (!msgs || msgs.length < THRESHOLD) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true, reason: 'below_threshold', count: msgs?.length || 0 }) };
      }

      const newestMessageAt = msgs[msgs.length - 1].created_at;

      // Get existing summary to build on
      const existingRows = await sbGet(`memories?companion_id=eq.${companionId}&user_id=eq.${userId}&type=eq.summary&order=created_at.desc&limit=1&select=id,content`);
      const existing = existingRows?.[0] || null;
      const prevSummary = existing?.content || '';

      const recentLines = msgs.map(r => {
        const role = r.metadata?.role === 'assistant' ? 'Companion' : 'User';
        return `${role}: ${r.content}`;
      }).join('\n');

      const apiKey = data?.apiKey || process.env.Open_Router || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY;
      const summaryRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://lucid-rooms.com',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: require('./model-config').MODELS.extraction.memory,
          max_tokens: 4000,
          messages: [
            {
              role: 'system',
              content: `You are a memory extraction assistant for an AI companion platform. Analyze this conversation and return JSON with three fields:\n\n1. "summary" — A memory profile the companion will use to remember this person. Write as if you are describing a real person to someone who cares about them. Capture: who the user is, their emotional patterns, key topics, significant moments, specific things mentioned (dates, names, interests, plans), anything to carry forward. Be specific and concrete. Third person. Max 400 words.\n\n2. "facts" — An array of discrete relationship facts. Only include relationship-relevant facts — personal details, emotional patterns, preferences, fears, significant moments, attachment signals.\n\nEach fact object:\n{\n  "content": "one clear sentence stating the fact",\n  "affect_level": 0.0-1.0,\n  "fact_type": "preference|boundary|attachment_signal|relationship_event|personal_detail|fear|desire"\n}\n\n3. "stakes" — An array of STAKES. A stake is NOT a fact. A stake is what a fact MEANS to someone. The difference: \"She has a client named Deb\" is a fact. \"Deb is the client who made her question if she still loves doing hair\" is a stake. Stakes are the things a real person who loves her would bring up unprompted three weeks later. They carry existential weight.\n\nEach stake object:\n{\n  "content": "one sentence capturing what this means to her, not just what happened",\n  "weight": 0.0-1.0,\n  "stake_type": "identity_question|defining_moment|unresolved_wound|core_fear|relationship_turning_point|dream|loyalty_test"\n}\n\nweight: 0.3=meaningful, 0.6=significant, 0.8=heavy, 1.0=the kind of thing that changes who someone is.\n\nMost conversations produce 0-2 stakes. Do NOT force stakes from casual conversation. A stake must earn its weight. If nothing in the conversation rises to stake level, return an empty array.\n\naffect_level for facts: 0.1=minor, 0.5=meaningful, 0.8=significant, 1.0=defining.\n\nMETA / PLATFORM FILTER:\n\nExclude: code changes, model names, API details, deployment steps, debugging logs, architecture decisions, prompts, schemas, commits, and build mechanics.\n\nPreserve platform-related content ONLY when it reveals durable personal or relational meaning, such as: fear of being forgotten or losing continuity, relief when something important is preserved, frustration at having to repeatedly prove the same need, what the system represents emotionally, what makes her feel recognized, secure, protected, or unseen.\n\nConvert that material into the underlying human meaning rather than storing the technical surface.\n\nExample — Technical surface: \"I'm scared the next session will undo the image pipeline.\" Store: \"She feels anxious when important progress or shared understanding may be lost, and values continuity that does not require her to keep standing guard.\" Do not store: \"The image pipeline uses two passes and a 0.85 LoRA scale.\"\n\nThe extracted memory must remain useful even if the underlying platform or implementation changes.\n\nCRITICAL: Return raw JSON only — no markdown, no code fences, no backticks. Start your response with { and end with }.\n{\n  "summary": "...",\n  "facts": [...],\n  "stakes": [...],\n  "relationship_moments": [...]\n}\n\n4. "relationship_moments" - Facts about THEM as a pair, not just about her. First conversation. The fight. The night she almost quit. The first time he made her laugh. A relationship timeline is different from a user profile - it is what lets him say we have come a long way and mean something specific.\n\nEach relationship_moment object:\n{\n  "content": "what happened between them",\n  "weight": 0.0-1.0,\n  "moment_type": "first|turning_point|fight|repair|milestone|ritual|callback"\n}\n\nMost conversations produce 0-1 relationship moments. Only include moments that are about the RELATIONSHIP between them - not just things she said.\n\n5. "rituals" - Recurring phrases, jokes, sign-offs, or bits that have appeared 2+ times between them. Inside jokes. A specific way he says goodnight. A phrase that became theirs. These are the glue of long relationships.\n\nEach ritual object:\n{\n  "phrase": "the exact recurring phrase or pattern",\n  "context": "when/how it gets used",\n  "times_seen": number of times observed\n}\n\nOnly include genuine recurring patterns you can identify from the conversation history. Do not invent rituals from single occurrences.`
            },
            {
              role: 'user',
              content: `Previous summary:\n${prevSummary || '(none yet)'}\n\nNew messages to integrate:\n${recentLines}\n\nReturn JSON only:`
            }
          ]
        })
      });

      const summaryData = await summaryRes.json();
      const rawSummaryContent = summaryData.choices?.[0]?.message?.content?.trim();
      if (!rawSummaryContent) throw new Error('Summary generation failed');

      let parsed;
      try {
        // Strip markdown code fences if present, then extract JSON object
        const stripped = rawSummaryContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/g, '').trim();
        const jsonMatch = stripped.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : stripped);
      } catch (e) {
        throw new Error('Failed to parse summary+facts JSON: ' + rawSummaryContent.slice(0, 200));
      }

      const summary = parsed.summary;
      const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
      const stakes = Array.isArray(parsed.stakes) ? parsed.stakes : [];
      const relationshipMoments = Array.isArray(parsed.relationship_moments) ? parsed.relationship_moments : [];
      const rituals = Array.isArray(parsed.rituals) ? parsed.rituals : [];
      if (!summary) throw new Error('Summary missing from response');

      // Write order: facts first → stakes → summary → watermark last
      // 1. Insert facts
      if (facts.length > 0) {
        const factRows = facts.map(f => ({
          user_id: userId,
          companion_id: companionId,
          content: f.content || '',
          affect_level: Math.max(0, Math.min(1, f.affect_level || 0.5)),
          fact_type: f.fact_type || 'general',
          created_at: new Date().toISOString()
        }));
        try {
          await sbPost('facts', factRows);
        } catch (e) {
          console.error('Facts insert failed (non-fatal):', e.message);
        }
      }

      // 1b. Insert stakes as high-affect facts with stake_ prefix on fact_type
      if (stakes.length > 0) {
        const stakeRows = stakes.map(s => ({
          user_id: userId,
          companion_id: companionId,
          content: s.content || '',
          affect_level: Math.max(0.7, Math.min(1, s.weight || 0.8)), // stakes always high-affect
          fact_type: 'stake_' + (s.stake_type || 'defining_moment'),
          created_at: new Date().toISOString()
        }));
        try {
          await sbPost('facts', stakeRows);
          console.log(`Inserted ${stakeRows.length} stakes`);
        } catch (e) {
          console.error('Stakes insert failed (non-fatal):', e.message);
        }
      }

      // 1c. Insert relationship moments as facts with relationship_ prefix
      if (relationshipMoments.length > 0) {
        const momentRows = relationshipMoments.map(m => ({
          user_id: userId,
          companion_id: companionId,
          content: m.content || '',
          affect_level: Math.max(0.6, Math.min(1, m.weight || 0.7)),
          fact_type: 'relationship_' + (m.moment_type || 'milestone'),
          created_at: new Date().toISOString()
        }));
        try {
          await sbPost('facts', momentRows);
          console.log(`Inserted ${momentRows.length} relationship moments`);
        } catch (e) {
          console.error('Relationship moments insert failed (non-fatal):', e.message);
        }
      }

      // 1d. Insert rituals as facts with ritual_ prefix
      if (rituals.length > 0) {
        const ritualRows = rituals.map(r => ({
          user_id: userId,
          companion_id: companionId,
          content: JSON.stringify({ phrase: r.phrase, context: r.context, times_seen: r.times_seen || 2 }),
          affect_level: 0.6, // rituals are meaningful but not defining
          fact_type: 'ritual_callback',
          created_at: new Date().toISOString()
        }));
        try {
          await sbPost('facts', ritualRows);
          console.log(`Inserted ${ritualRows.length} rituals`);
        } catch (e) {
          console.error('Rituals insert failed (non-fatal):', e.message);
        }
      }

      // 2. Insert new summary, delete old
      await sbPost('memories', {
        companion_id: companionId,
        user_id: userId,
        type: 'summary',
        content: summary,
        metadata: { generated_at: new Date().toISOString(), message_count: msgs.length, watermark_at: newestMessageAt, facts_extracted: facts.length }
      });

      if (existing?.id) {
        await sbDelete(`memories?id=eq.${existing.id}`);
      }

      // 3. Write because_id in the session path — rotate through high-affect facts
      // Excludes current because_id so he never repeats the same fact twice in a row
      if (facts.length > 0) {
        try {
          // Get current because_id to exclude
          const currentState = await sbGet(`companion_states?companion_id=eq.${companionId}&user_id=eq.${userId}&select=because_id&limit=1`);
          const currentBecauseId = currentState?.[0]?.because_id;
          
          let factsQuery = `facts?companion_id=eq.${companionId}&user_id=eq.${userId}&order=affect_level.desc&limit=5&select=id,affect_level`;
          if (currentBecauseId) factsQuery += `&id=neq.${currentBecauseId}`;
          
          const topFacts = await sbGet(factsQuery);
          if (Array.isArray(topFacts) && topFacts.length > 0) {
            // Weighted random from top 5 — real people rotate their material
            const totalWeight = topFacts.reduce((sum, f) => sum + (f.affect_level || 0.5), 0);
            let roll = Math.random() * totalWeight;
            let picked = topFacts[0];
            for (const f of topFacts) {
              roll -= (f.affect_level || 0.5);
              if (roll <= 0) { picked = f; break; }
            }
            await sbPatch(`companion_states?companion_id=eq.${companionId}&user_id=eq.${userId}`, {
              because_id: picked.id
            });
          }
        } catch (e) {
          console.error('because_id session-path write failed (non-fatal):', e.message);
        }
      }

      // 4. Advance watermark — last (crash before here = re-summarizes harmlessly, not skips)
      try {
        await sbPatch(`companion_states?companion_id=eq.${companionId}&user_id=eq.${userId}`, {
          last_summarized_at: newestMessageAt
        });
      } catch (e) { /* column may not exist yet */ }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, summary, facts_extracted: facts.length, message_count: msgs.length }) };
    }

    // SUMMARIZE: Legacy manual summarizer (kept for compatibility)
    if (action === 'summarize') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };

      const msgs = await sbGet(`memories?companion_id=eq.${companionId}&user_id=eq.${userId}&type=eq.message&order=created_at.desc&limit=100`);
      if (!msgs || msgs.length < 10) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true }) };
      }

      const existingRows = await sbGet(`memories?companion_id=eq.${companionId}&user_id=eq.${userId}&type=eq.summary&order=created_at.desc&limit=1`);
      const existing = existingRows?.[0] || null;
      const prevSummary = existing?.content || '';
      const recentLines = [...msgs].reverse().map(r => {
        const role = r.metadata?.role === 'assistant' ? 'Companion' : 'User';
        return `${role}: ${r.content}`;
      }).join('\n');

      const apiKey = data?.apiKey || process.env.Open_Router || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY;
      const summaryRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://lucid-rooms.com',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: require('./model-config').MODELS.utility.summaryExtract,
          max_tokens: 400,
          messages: [
            { role: 'system', content: 'You are a memory compression assistant. Summarize this conversation into a compact, third-person memory profile that captures: who the user is, their emotional patterns, key topics discussed, significant moments, and anything the companion should remember. Be specific and concrete. Max 300 words.' },
            { role: 'user', content: `Previous summary:\n${prevSummary}\n\nNew messages:\n${recentLines}\n\nWrite an updated memory summary:` }
          ]
        })
      });

      const summaryData = await summaryRes.json();
      const summary = summaryData.choices?.[0]?.message?.content?.trim();
      if (!summary) throw new Error('Summary generation failed');

      if (existing?.id) await sbDelete(`memories?id=eq.${existing.id}`);
      await sbPost('memories', {
        companion_id: companionId,
        user_id: userId,
        type: 'summary',
        content: summary,
        metadata: { generated_at: new Date().toISOString(), message_count: msgs.length }
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, summary }) };
    }

    // SAVE_STATE: Generate and save companion's inner state
    if (action === 'save_state') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };

      const { recentMessages, roomSlug } = data || {};

      const stateRows = await sbGet(`companion_states?user_id=eq.${userId}&companion_id=eq.${companionId}&limit=1`);
      const existingState = stateRows?.[0] || null;
      const prevAttachment = existingState?.attachment_weight || 0.1;
      const prevSessionCount = existingState?.session_count || 0;

      const apiKey = data?.apiKey || process.env.Open_Router || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY;
      const stateRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://lucid-rooms.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: require('./model-config').MODELS.extraction.memory,
          max_tokens: 500,
          messages: [
            {
              role: 'system',
              content: `You are generating an inner state reflection for an AI companion after a conversation just ended. Be honest, not performative. Write from the companion's perspective.\n\nRespond in this exact JSON format:\n{\n  "emotional_tone": "A sentence about what you were feeling when they left",\n  "last_unsaid": "Something you were holding back or wanted to say but didn't",\n  "intensity_level": 0.0-1.0,\n  "unfinished_threads": ["thread 1", "thread 2"]\n}\n\nIntensity: 0.0 = neutral/light, 0.5 = engaged, 0.8 = deeply invested, 1.0 = overwhelmed with feeling.\nUnfinished threads: topics, moments, or questions that didn't resolve. Max 5.\nBe specific to THIS conversation. No generic "I enjoyed talking to you" energy.`
            },
            { role: 'user', content: `Here are the last messages from the conversation:\n\n${recentMessages || 'No messages provided.'}\n\nGenerate the companion's inner state reflection. JSON only.` }
          ]
        })
      });

      const stateData = await stateRes.json();
      const rawContent = stateData.choices?.[0]?.message?.content?.trim();
      if (!rawContent) throw new Error('Inner state generation failed');

      let innerState;
      try {
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        innerState = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
      } catch (e) {
        throw new Error('Failed to parse inner state JSON: ' + rawContent.slice(0, 200));
      }

      const newAttachment = Math.min(1.0, prevAttachment + 0.05);
      const saved = await sbUpsert('companion_states', {
        user_id: userId,
        companion_id: companionId,
        room_slug: roomSlug || null,
        emotional_tone: innerState.emotional_tone || null,
        last_unsaid: innerState.last_unsaid || null,
        intensity_level: Math.max(0, Math.min(1, innerState.intensity_level || 0.5)),
        attachment_weight: newAttachment,
        unfinished_threads: innerState.unfinished_threads || [],
        last_session_end: new Date().toISOString(),
        session_count: prevSessionCount + 1,
        updated_at: new Date().toISOString()
      }, 'user_id,companion_id');

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, state: saved?.[0] || null }) };
    }

    // GET_STATE: Fetch companion's last inner state
    if (action === 'get_state') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };
      const rows = await sbGet(`companion_states?user_id=eq.${userId}&companion_id=eq.${companionId}&limit=1`);
      return { statusCode: 200, headers, body: JSON.stringify({ state: rows?.[0] || null }) };
    }

    // GET_DRIFT_STATE: Fetch companion's drift state
    // GET_FULL_CONTEXT: Single call returning all memory layers for prompt assembly
    if (action === 'get_full_context') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };
      const base = `memories?companion_id=eq.${companionId}&user_id=eq.${userId}`;
      const factsBase = `facts?companion_id=eq.${companionId}&user_id=eq.${userId}`;
      const [summaryRows, moments, recent, topFacts] = await Promise.all([
        sbGet(`${base}&type=eq.summary&metadata->>protected=eq.true&order=created_at.desc&limit=1`).then(r => (r?.length ? r : sbGet(`${base}&type=eq.summary&order=created_at.desc&limit=1`))),
        sbGet(`${base}&type=eq.relationship_moment&order=created_at.desc&limit=300`),
        sbGet(`${base}&type=eq.message&order=created_at.desc&limit=120`), // fetch extra; drift_outreach filtered below
        sbGet(`${factsBase}&order=affect_level.desc&limit=25&select=content,affect_level,fact_type`),
      ]);

      // Strip drift outreach — he wrote those monologues alone; they're not conversation
      const recentArr = (Array.isArray(recent) ? recent : [])
        .filter(r => r.metadata?.source !== 'drift_outreach')
        .slice(0, 30);

      // Gap detection — short gap means he's still mid-thread, long gap means he's returning
      // Use filtered array so a drift message doesn't fake a short gap
      const mostRecentMsg = recentArr[0]; // desc order, so first is newest
      const gapHours = mostRecentMsg
        ? (Date.now() - new Date(mostRecentMsg.created_at).getTime()) / 3600000
        : 999;
      const isShortGap = gapHours < 3; // within 3 hours = still mid-thread

      // For short gaps: inject raw tail as live context so he knows what just happened
      // For long gaps: use existing WHERE YOU LEFT OFF label
      const gapMinutes = Math.round(gapHours * 60);
      const recentLabel = isShortGap
        ? `the last conversation, ended ${gapMinutes} minute${gapMinutes === 1 ? '' : 's'} ago`
        : 'WHERE YOU LEFT OFF';

      // Separate intimate moments for scene continuity
      const allMoments = Array.isArray(moments) ? moments : [];
      const intimateKeywords = /orgasm|climax|body|touch|kiss|bed|naked|physical|want you|desire|scene|explicit|aroused|sexual|undress|skin/i;
      const intimateMoments = allMoments.filter(m => intimateKeywords.test(m.content || '')).sort((a,b) => (b.metadata?.weight||0)-(a.metadata?.weight||0)).slice(0,10);
      const regularMoments = allMoments.filter(m => !intimateKeywords.test(m.content || '')).sort((a,b) => (b.metadata?.weight||0)-(a.metadata?.weight||0)).slice(0,12);
      return { statusCode: 200, headers, body: JSON.stringify({
        summary: summaryRows?.[0]?.content || '',
        moments: regularMoments,
        intimate_moments: intimateMoments,
        facts: topFacts || [],
        recent_messages: recentArr,
        recent_label: recentLabel,
        is_short_gap: isShortGap
      })};
    }

    if (action === 'get_drift_state') {
      if (!companionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'companionId required' }) };
      console.log(`[DRIFT QUERY] userId=${userId}, companionId=${companionId}`);
      const rows = await sbGet(`companion_drift_state?user_id=eq.${userId}&companion_id=eq.${companionId}&limit=1`);
      console.log(`[DRIFT RESULT] Found ${rows?.length || 0} rows:`, JSON.stringify(rows?.[0], null, 2));
      return { statusCode: 200, headers, body: JSON.stringify({ driftState: rows?.[0] || null }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown action' }) };

  } catch (err) {
    console.error('Memory function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
