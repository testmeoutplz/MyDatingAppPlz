"""
Flask backend for dating-like demo.
Reads `config.json` for Ollama host and model and forwards chat requests.

Endpoints:
- GET  /api/people     -> returns shuffled people and `user` entry
- POST /api/discard    -> mark a person discarded in session
- POST /api/chat       -> forwards message to configured Ollama server and returns reply

Config expectations (config.json):
{
  "ollama_host": "192.168.1.2:11434"  # or "http://192.168.1.2:11434" or "192.168.1.2"
  "ollama_model": "<model-name>"
}

"""
from __future__ import annotations

import json
import os
import re
import logging
from typing import Optional

from flask import Flask, render_template, jsonify, request, session
from flask_cors import CORS
import xml.etree.ElementTree as ET
import requests

# We provide a server-side proxy endpoint `/api/proxy_chat` so the browser
# doesn't have to call Ollama directly (avoids CORS and connectivity issues).


BASE_DIR = os.path.dirname(__file__)
CFG_PATH = os.path.join(BASE_DIR, 'config.json')
DATA_FILE = os.path.join(BASE_DIR, 'data', 'people.xml')

logging.basicConfig(level=logging.INFO)
log = logging.getLogger('dating-backend')

app = Flask(__name__, static_folder='static', template_folder='templates')
CORS(app)
app.secret_key = os.environ.get('FLASK_SECRET', 'dev-secret-key')


def load_config() -> dict:
    if os.path.exists(CFG_PATH):
        try:
            with open(CFG_PATH, 'r') as f:
                cfg = json.load(f)
                return cfg
        except Exception as e:
            log.exception('Failed to parse config.json')
            return {}
    return {}


def build_ollama_api_url(cfg: dict) -> str:
    """Return full URL to Ollama chat API based on config values.

    Accepts these forms in `ollama_host`:
      - http://host:port
      - host:port
      - host (port default 11434)
    """
    host = (cfg.get('ollama_host') or '').strip()
    if not host:
        host = 'localhost:11434'

    # If full URL provided, normalize and append path
    if host.startswith('http://') or host.startswith('https://'):
        base = host.rstrip('/')
    else:
        # add default port if missing
        if ':' not in host:
            host = f"{host}:11434"
        base = f"http://{host}"

    return base + '/api/chat'


def sanitize_ai_text(s: Optional[str]) -> str:
    if not s:
        return ''
    # strip bracket or angle tags like [start], [end], <tag>
    s = re.sub(r"\[.*?\]", '', s)
    s = re.sub(r"<.*?>", '', s)
    s = re.sub(r"\s+", ' ', s)
    return s.strip()


def load_people() -> list[dict]:
    if not os.path.exists(DATA_FILE):
        return []
    try:
        tree = ET.parse(DATA_FILE)
    except ET.ParseError as e:
        log.exception('Failed to parse XML: %s', e)
        raise
    root = tree.getroot()
    people = []
    for p in root.findall('person'):
        person = {}
        # read child tags except image
        for child in p:
            if child.tag == 'image':
                continue
            person[child.tag] = child.text or ''
        person['id'] = p.get('id') or person.get('id') or str(len(people) + 1)
        imgs = [i.text or '' for i in p.findall('image')]
        person['images'] = imgs
        if 'special' in p.attrib:
            person['special'] = p.attrib.get('special')
        people.append(person)
    return people


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/people')
def api_people():
    people = load_people()
    discarded = session.get('discarded', [])
    candidates = [p for p in people if p.get('special') != 'self' and p.get('id') not in discarded]
    if not candidates:
        # reshuffle
        session['discarded'] = []
        candidates = [p for p in people if p.get('special') != 'self']
    import random
    random.shuffle(candidates)
    user = next((p for p in people if p.get('special') == 'self'), None)
    return jsonify({'people': candidates, 'user': user})


@app.route('/api/discard', methods=['POST'])
def api_discard():
    body = request.get_json(silent=True) or {}
    pid = body.get('id')
    if not pid:
        return jsonify({'error': 'missing id'}), 400
    discarded = session.get('discarded', [])
    if pid not in discarded:
        discarded.append(pid)
    session['discarded'] = discarded
    return jsonify({'status': 'ok', 'discarded': discarded})


@app.route('/api/chat', methods=['POST'])
def api_chat():
    cfg = load_config()
    # allow environment overrides for host/model
    if os.environ.get('OLLAMA_HOST'):
        cfg['ollama_host'] = os.environ.get('OLLAMA_HOST')
    if os.environ.get('OLLAMA_MODEL'):
        cfg['ollama_model'] = os.environ.get('OLLAMA_MODEL')

    model = cfg.get('ollama_model')
    if not model:
        return jsonify({'error': 'server_config_missing_model', 'message': 'Set "ollama_model" in config.json or OLLAMA_MODEL env var'}), 500

    ollama_url = build_ollama_api_url(cfg)
    log.info('Using Ollama model: %s', model)
    body = request.get_json(silent=True) or {}
    person_id = body.get('person_id')
    message = body.get('message', '')

    people = load_people()
    person = next((p for p in people if p.get('id') == person_id), None)
    user = next((p for p in people if p.get('special') == 'self'), None)
    if person is None:
        return jsonify({'error': 'person not found'}), 400

    system_prompt = (
        f"You are {person.get('name')} (age {person.get('age')}). Tagline: {person.get('tagline')}."
        f" Likes: {person.get('likes')}. Bio: {person.get('description','')}."
        f" The user is {user.get('name')} (age {user.get('age')}). User bio: {user.get('description','')}"
        " Stay in character and answer conversationally."
    )

    # Instead of contacting Ollama from the backend, return the assembled
    # system prompt and the user's message to the frontend. The frontend will
    # perform the HTTP call to the Ollama server directly (per user's request).
    return jsonify({
        'system_prompt': system_prompt,
        'user_message': message,
        'person': {k: person.get(k) for k in ('id', 'name', 'age', 'tagline', 'likes', 'description')},
        'user': {k: user.get(k) for k in ('id', 'name', 'age', 'description')},
        'ollama_host': cfg.get('ollama_host'),
        'ollama_model': cfg.get('ollama_model')
    })


@app.route('/api/proxy_chat', methods=['POST'])
def api_proxy_chat():
    """Proxy a chat request to the configured Ollama server and return a
    sanitized assistant reply.
    Expected POST body: { model?: str, messages: [{role,content}, ...] }
    If `model` is missing in the request body, the server config's model is used.
    """
    cfg = load_config()
    if os.environ.get('OLLAMA_HOST'):
        cfg['ollama_host'] = os.environ.get('OLLAMA_HOST')
    if os.environ.get('OLLAMA_MODEL'):
        cfg['ollama_model'] = os.environ.get('OLLAMA_MODEL')

    body = request.get_json(silent=True) or {}
    req_model = body.get('model') or cfg.get('ollama_model')
    messages = body.get('messages') or []

    if not messages:
        return jsonify({'error': 'missing_messages'}), 400

    ollama_url = build_ollama_api_url(cfg)
    # Prepare payload to Ollama
    payload = {'model': req_model, 'messages': messages}
    headers = {'Content-Type': 'application/json', 'Ollama-Model': req_model or ''}

    try:
        resp = requests.post(ollama_url, json=payload, headers=headers, timeout=60)
    except requests.RequestException as e:
        log.exception('Proxy failed contacting Ollama')
        return jsonify({'error': 'connection_failed', 'detail': str(e)}), 502

    status = resp.status_code
    text_body = resp.text or ''
    log.info('Proxy Ollama status=%s', status)

    # collect pieces from JSON / NDJSON streaming lines
    pieces: list[str] = []

    def collect_from_obj(obj):
        if not obj:
            return
        if isinstance(obj, dict):
            msg = obj.get('message') or {}
            if isinstance(msg, dict):
                c = msg.get('content')
                if isinstance(c, str) and c:
                    pieces.append(c)
            for k in ('content', 'text', 'reply'):
                v = obj.get(k)
                if isinstance(v, str) and v:
                    pieces.append(v)
            chs = obj.get('choices')
            if isinstance(chs, list):
                for ch in chs:
                    if isinstance(ch, dict):
                        cm = (ch.get('message') or {}).get('content')
                        if isinstance(cm, str) and cm:
                            pieces.append(cm)
                        if isinstance(ch.get('text'), str) and ch.get('text'):
                            pieces.append(ch.get('text'))
        elif isinstance(obj, str):
            pieces.append(obj)

    # Try standard JSON first
    try:
        jr = resp.json()
    except Exception:
        jr = None

    if jr:
        if isinstance(jr, list):
            for item in jr:
                collect_from_obj(item)
        else:
            collect_from_obj(jr)

    if not pieces and text_body:
        for line in text_body.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                try:
                    decoder = json.JSONDecoder()
                    obj, _ = decoder.raw_decode(line)
                except Exception:
                    # not JSON
                    pieces.append(line)
                    continue
            collect_from_obj(obj)

    if pieces:
        reply_text = ''.join(pieces).strip()
    else:
        reply_text = text_body.strip()

    # sanitize
    s = re.sub(r"\[.*?\]", '', reply_text)
    s = re.sub(r"<.*?>", '', s)
    s = re.sub(r"\s+'\s+", "'", s)
    s = re.sub(r"\s+'", "'", s)
    s = re.sub(r"'\s+", "'", s)
    s = re.sub(r"\b(\w+)(?:\s+\1\b)+", r"\1", s, flags=re.I)
    s = re.sub(r"\s+([.,!?;:])", r"\1", s)
    s = re.sub(r"\s+", ' ', s).strip()

    if not s:
        return jsonify({'error': 'no_reply_extracted', 'status': status, 'body': text_body[:2000]}), 502

    return jsonify({'reply': s}), 200


if __name__ == '__main__':
    cfg = load_config()
    log.info('Starting Flask app; Ollama host from config: %s', cfg.get('ollama_host'))
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5001)), debug=True)
