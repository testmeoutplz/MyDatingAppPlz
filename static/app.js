let state = { people: [], user: null, current: 0, matched: null }

// Simple client-side memory store (per matched person)
function memoryKey(personId){
  const uid = state.user && state.user.id ? state.user.id : 'anon'
  return `chat_mem:${uid}:${personId}`
}

function loadMemory(personId){
  try{
    const raw = localStorage.getItem(memoryKey(personId))
    if (!raw) return []
    return JSON.parse(raw)
  }catch(e){ return [] }
}

function saveMemory(personId, arr){
  try{ localStorage.setItem(memoryKey(personId), JSON.stringify(arr)) }catch(e){}
}

function saveMessageToMemory(personId, role, text){
  if (!personId) return
  const mem = loadMemory(personId)
  mem.push({role, text: String(text), t: Date.now()})
  // keep last 200 turns max
  if (mem.length > 200) mem.splice(0, mem.length - 200)
  saveMemory(personId, mem)
}

function getRecentForPayload(personId, limit=12){
  const mem = loadMemory(personId) || []
  // return the last `limit` items as messages suitable for model payload
  return mem.slice(-limit).map(m=>({role: m.role, content: m.text}))
}

function getMemorySummary(personId){
  const mem = loadMemory(personId)
  if (!mem || mem.length === 0) return ''
  // produce a very short summary: list recent topics / repeated keywords
  try{
    const text = mem.slice(-20).map(m=>m.text).join(' ')
    // naive keyword extraction: common words minus stopwords
    const stop = new Set(['the','a','an','and','or','to','i','you','we','it','is','are','of','for','on','in','that','this','with'])
    const counts = Object.create(null)
    text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).forEach(w=>{ if (!w||stop.has(w) || w.length<3) return; counts[w]= (counts[w]||0)+1 })
    const keys = Object.keys(counts).sort((a,b)=>counts[b]-counts[a]).slice(0,6)
    if (keys.length===0) return ''
    return `Recent topics: ${keys.join(', ')}.`
  }catch(e){ return '' }
}

async function loadPeople(){
  const res = await fetch('/api/people')
  const j = await res.json()
  state.people = j.people
  state.user = j.user
  renderStack()
}

function renderStack(){
  const stack = document.getElementById('cardStack')
  stack.innerHTML = ''
  state.people.forEach((p, i)=>{
    const card = document.createElement('div')
    card.className = 'card'
    card.style.zIndex = state.people.length - i
    card.dataset.id = p.id
    card.innerHTML = `
      <img src="${p.images[0]}" data-idx="0">
      <div class="meta"><h3>${p.name}, ${p.age}</h3><div class="tagline">${p.tagline}</div></div>
      <div class="likes"><strong>Interests:</strong> ${p.likes}</div>
    `
    addDrag(card)
    stack.appendChild(card)
    // image tap toggling handled inside `addDrag` (ignores taps that were drags)
  })
}

function addDrag(card){
  let startX=0, startY=0
  const img = card.querySelector('img')
  let moved = false
  function onStart(e){
    // prevent image drag / text selection on touchstart
    if (e && e.preventDefault) e.preventDefault()
    const ev = e.touches? e.touches[0]: e
    startX = ev.clientX
    startY = ev.clientY
    card.style.transition = ''
    moved = false
    card.classList.add('dragging')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onMove)
    window.addEventListener('touchend', onEnd)
  }
  function onMove(e){
    const ev = e.touches? e.touches[0]: e
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx/20}deg)`
  }
  function onEnd(e){
    const style = getComputedStyle(card)
    const matrix = new WebKitCSSMatrix(style.transform)
    const dx = matrix.m41
    if (dx > 120){ // right swipe -> match
      matchCard(card.dataset.id)
      card.remove()
    } else if (dx < -120){ // left swipe -> discard
      discardCard(card.dataset.id)
      card.remove()
    } else {
      card.style.transition = 'transform .2s'
      card.style.transform = ''
    }
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onEnd)
    window.removeEventListener('touchmove', onMove)
    window.removeEventListener('touchend', onEnd)
    card.classList.remove('dragging')
  }
  card.addEventListener('mousedown', onStart)
  card.addEventListener('touchstart', onStart)

  // make image tap toggle ignore when it was part of a drag
  img.addEventListener('click', (ev)=>{
    if (moved) return
    const idx = parseInt(img.dataset.idx)
    const next = 1-idx
    img.src = state.people.find(p=>p.id==card.dataset.id).images[next] || img.src
    img.dataset.idx = next
  })
}

async function discardCard(id){
  await fetch('/api/discard',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})})
}

let lastMatched = null
function matchCard(id){
  const p = state.people.find(x=>x.id==id)
  lastMatched = p
  document.getElementById('matchText').innerText = `You and ${p.name} matched!`
  // set avatars (matched person + user)
  const matchAvatar = document.getElementById('matchAvatar')
  const userAvatar = document.getElementById('userAvatar')
  if (matchAvatar) matchAvatar.src = p.images && p.images[0] ? p.images[0] : ''
  if (userAvatar) userAvatar.src = state.user && state.user.images && state.user.images[0] ? state.user.images[0] : ''
  // ensure modal sits on top
  document.getElementById('matchModal').style.zIndex = 9999
  document.getElementById('matchModal').classList.remove('hidden')
}

document.getElementById('openChat').addEventListener('click', ()=>{
  document.getElementById('matchModal').classList.add('hidden')
  openChatWith(lastMatched)
})

function openChatWith(person){
  state.matched = person
  document.getElementById('swipeView').classList.add('hidden')
  document.getElementById('chatView').classList.remove('hidden')
  document.getElementById('chatAvatar').src = person.images[0]
  document.getElementById('chatName').innerText = `${person.name}, ${person.age}`
  const messagesDiv = document.getElementById('messages')
  messagesDiv.innerHTML = ''
  // render persisted conversation (if any) without re-saving
  const mem = loadMemory(person.id)
  if (mem && mem.length){
    mem.forEach(m=> appendMsg(m.text, m.role, {save:false}))
  }
  // switch page background to yellow once chat is opened
  document.body.classList.add('match-mode')
  // prevent the page from scrolling while chat is active
  document.body.classList.add('no-scroll')
}

// Profile modal helpers -------------------------------------------------
const profileModal = document.getElementById('profileModal')
const profileImage = document.getElementById('profileImage')

function openProfileModal(person){
  if (!person) return
  profileImage.dataset.idx = '0'
  profileImage.src = (person.images && person.images[0]) ? person.images[0] : ''
  // attach person to modal for toggling
  profileModal.person = person
  profileModal.classList.remove('hidden')
}

// toggle image on profile modal click
profileImage.addEventListener('click', ()=>{
  const person = profileModal.person
  if (!person) return
  const idx = parseInt(profileImage.dataset.idx || '0')
  const next = (person.images && person.images.length > 1) ? 1 - idx : idx
  profileImage.dataset.idx = String(next)
  profileImage.src = person.images[next] || profileImage.src
})

// close modal when tapping outside content
profileModal.addEventListener('click', (e)=>{
  if (e.target === profileModal) profileModal.classList.add('hidden')
})

// wire avatar clicks: chat avatar, match modal avatars
document.getElementById('chatAvatar').addEventListener('click', ()=> openProfileModal(state.matched))
document.getElementById('matchAvatar').addEventListener('click', ()=> openProfileModal(lastMatched))
document.getElementById('userAvatar').addEventListener('click', ()=> openProfileModal(state.user))

document.getElementById('backToSwipe').addEventListener('click', ()=>{
  // Clear chat history and return to swipe view
  document.getElementById('messages').innerHTML = ''
  state.matched = null
  document.getElementById('chatView').classList.add('hidden')
  document.getElementById('swipeView').classList.remove('hidden')
  // restore default background
  document.body.classList.remove('match-mode')
  // allow page scrolling again
  document.body.classList.remove('no-scroll')
  // re-render stack to ensure visual consistency
  renderStack()
})

document.getElementById('msgForm').addEventListener('submit', async (e)=>{
  e.preventDefault()
  const input = document.getElementById('msgInput')
  const text = input.value.trim()
  if (!text) return
  appendMsg(text, 'user')
  input.value = ''
  // First ask backend to assemble the system prompt and return Ollama config
  const metaRes = await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({person_id: state.matched.id, message: text})})
  const meta = await metaRes.json()
  if (meta.error){
    appendMsg('Error: ' + (meta.message || meta.error), 'ai')
    return
  }

  // Build Ollama URL
  const host = meta.ollama_host || 'localhost:11434'
  const model = meta.ollama_model || ''
  const base = host.startsWith('http') ? host.replace(/\/$/, '') : 'http://' + host
  const ollamaUrl = `${base}/api/chat`

  // Include the model in the JSON body (not the URL path). Some Ollama
  // deployments expect `model` in the body rather than the URL.
  const payload = {}
  if (model) payload.model = model
  payload.messages = [
    {role: 'system', content: meta.system_prompt},
    {role: 'user', content: meta.user_message}
  ]

  // Ensure AI knows this is a Dating text-only chat and constrain style
  const extraSystem = `You are role-playing a casual texting conversation on Bumble. All chats are text-only. Both participants are looking for a relationship. Always write in first person (I/me). Use contractions and short sentences, like real texting. Keep replies concise (1-3 short lines), ask a light follow-up question when appropriate, and refer briefly to previous topics if relevant. Use emojis sparingly and naturally. Do NOT produce long essays, bullet lists, or system-style explanations.`
  if (payload.messages && payload.messages[0] && payload.messages[0].content){
    payload.messages[0].content = payload.messages[0].content + "\n\n" + extraSystem
  } else {
    payload.messages.unshift({role: 'system', content: extraSystem})
  }

  // Optimize for faster responses by limiting length and setting a reasonable temperature
  // These fields may be used by the backend proxy / Ollama if supported.
  payload.max_tokens = 120
  payload.temperature = 0.7
  payload.stream = false

  try{
    // Before sending to proxy, inject recent conversation turns and a short memory summary
    const recent = getRecentForPayload(state.matched.id, 12)
    const summary = getMemorySummary(state.matched.id)
    if (summary){
      payload.messages.unshift({role:'system', content: `Memory summary: ${summary}`})
    }
    // append recent turns (do not include the current user message yet)
    if (recent && recent.length){
      // place recent historical turns after system and before the new user message
      payload.messages = payload.messages.slice(0,1).concat(recent).concat(payload.messages.slice(1))
    }

    // Use backend proxy to avoid CORS and connectivity issues
    const proxyRes = await fetch('/api/proxy_chat', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})
    const pj = await proxyRes.json()
    if (pj.error){
      appendMsg('Error: ' + (pj.detail || pj.error || pj.message), 'ai')
      return
    }
    const txt = pj.reply || ''
    // Try parsing NDJSON / streaming lines
    let reply = ''
    for (const line of txt.split(/\r?\n/)){
      if (!line.trim()) continue
      try{
        const obj = JSON.parse(line)
        // extract common fields
        if (obj.message && obj.message.content) reply += obj.message.content
        else if (obj.content) reply += obj.content
        else if (obj.text) reply += obj.text
        else if (obj.choices && Array.isArray(obj.choices)){
          for (const ch of obj.choices){
            if (ch.message && ch.message.content) reply += ch.message.content
            else if (ch.text) reply += ch.text
          }
        }
      }catch(e){
        // not json, append raw line
        reply += line
      }
    }
    reply = reply.trim()
    if (!reply) reply = txt.trim()
    appendMsg(reply || 'Error: empty response', 'ai')
  }catch(e){
    appendMsg('Error contacting Ollama: ' + String(e), 'ai')
  }
})

function appendMsg(text, who, opts){
  opts = opts || {}
  const save = opts.save === undefined ? true : Boolean(opts.save)
  const personId = state.matched && state.matched.id ? state.matched.id : null
  // if image object, prefer showing image
  const container = document.getElementById('messages')
  const m = document.createElement('div')
  m.className = 'bubble ' + (who === 'user' ? 'user' : 'ai')
  if (typeof text === 'object' && text.image){
    const img = document.createElement('img')
    img.src = text.image
    img.style.maxWidth = '70%'
    img.style.borderRadius = '12px'
    m.appendChild(img)
  } else {
    // preserve basic line breaks for realistic texting
    const s = String(text)
    m.innerText = s
  }
  container.appendChild(m)
  container.scrollTop = container.scrollHeight
  // save to local memory store
  if (save && personId){
    try{ saveMessageToMemory(personId, who === 'user' ? 'user' : 'assistant', typeof text === 'object' && text.image ? '[image]' : String(text)) }catch(e){}
  }
}

// Attach / photo handling
const attachBtn = document.getElementById('attachBtn')
const attachInput = document.getElementById('attachInput')
attachBtn.addEventListener('click', ()=> attachInput.click())
attachInput.addEventListener('change', (ev)=>{
  const f = ev.target.files && ev.target.files[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = (e)=>{
    const dataUrl = e.target.result
    // append image bubble locally (do NOT send to Ollama)
    appendMsg({image: dataUrl}, 'user')
  }
  reader.readAsDataURL(f)
  // clear input so same file can be selected again
  attachInput.value = ''
})

loadPeople()