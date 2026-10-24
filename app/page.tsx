'use client';
import { useEffect, useState } from 'react';
type FileRow = {
    id: string;
    filename: string;
    mime_type: string;
    bytes: number;
    download_path: string;
    kind: string;
};
export default function Home() {
    const [state, setState] = useState<any>(null);
    const [files, setFiles] = useState<FileRow[]>([]);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [cursor, setCursor] = useState<string | null>(null);
    async function refresh() { try {
        const r = await fetch('/api/status');
        const s = await r.json();
        setState(s);
        if (r.ok)
            await loadFiles();
    }
    catch {
        setMessage('Connection unavailable. Please refresh to try again.');
    } }
    async function loadFiles(next?: string) { const r = await fetch('/api/files' + (next ? '?cursor=' + encodeURIComponent(next) : '')); const d: any = await r.json(); if (r.ok) {
        setFiles(f => next ? [...f, ...d.files] : d.files);
        setCursor(d.next_cursor);
    }
    else
        setMessage(d.error?.message ?? 'Files unavailable.'); }
    useEffect(() => { refresh(); }, []);
    async function upload(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); const file = data.get('file') as File; if (!file?.size)
        return; setBusy(true); setMessage('Uploading privately…'); try {
        const r = await fetch('/api/upload', { method: 'POST', body: data });
        const d: any = await r.json();
        if (!r.ok)
            throw new Error(d.error?.message ?? 'Upload failed.');
        setMessage('Uploaded. File ID: ' + d.id);
        form.reset();
        await loadFiles();
    }
    catch (e) {
        setMessage(e instanceof Error ? e.message : 'Upload failed. Please retry.');
    }
    finally {
        setBusy(false);
    } }
    return <main><header><a className="brand" href="/" aria-label="AI Studio Connector home"><span className="mark">AI</span><span>AI Studio Connector<small>PRIVATE · GOOGLE GENAI SDK</small></span></a><button className="subtle" onClick={refresh}>Refresh status</button></header><section className="status"><div><p className="eyebrow">YOUR CONNECTION</p><h1>{state?.key_configured ? 'Ready for your next request' : state?.error ? 'Sign in to your owner account' : 'Connect your AI Studio key'}</h1><p>{state?.key_configured ? 'Use the plugin in chat for speech, audio understanding, music and multimodal requests. Google access is checked only when you make a request.' : 'Your key stays in server-side Sites Secrets. It is never entered here or sent through chat.'}</p></div><span className={'badge ' + (state?.key_configured ? 'ready' : '')}>{state?.key_configured ? 'Key configured' : state?.error ? 'Owner access required' : 'Key not configured'}</span></section>{state?.error ? <section className="panel"><p>{state.error.message}</p><a className="button" href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></section> : <><section className="grid"><div className="panel"><p className="eyebrow">SETUP</p><h2>A private connection, in two steps</h2><ol><li>Open <a href="https://chatgpt.com/sites" target="_blank" rel="noreferrer">Sites</a>, find AI Studio Connector, then More actions → Settings. Add <code>GEMINI_API_KEY</code> and mark it as a secret</li><li>Save, then ask dot to redeploy and check the connection. Install this plugin from Plugins → Personal → Created by you</li></ol><p className="muted">Do not paste a key in chat. Only explicit generation requests use Google quota. No live Google call has been made by this setup page.</p></div><div className="panel"><p className="eyebrow">CAPABILITIES</p><h2>One client, multiple modalities</h2><ul className="capabilities"><li><b>Speech</b><span>Single- and two-speaker TTS</span></li><li><b>Listen & critique</b><span>Audio transcription and model analysis</span></li><li><b>Music</b><span>Lyria clips and supported music models</span></li><li><b>General generation</b><span>Text, images, video, PDFs and structured JSON</span></li></ul><p className="muted">Model access depends on your Google account. Your preference is to keep coding tasks outside Gemini.</p></div></section><section className="panel media"><div><p className="eyebrow">PRIVATE FILES</p><h2>Upload once, use in chat</h2><p>Audio, video, image or PDF · Up to 8 MiB per file. Uploading stores the file here; only an authorized generation request sends it to Google.</p></div><form onSubmit={upload}><label htmlFor="file">Choose input file</label><input id="file" name="file" type="file" accept="audio/*,video/mp4,video/webm,image/png,image/jpeg,image/webp,application/pdf" required/><button disabled={busy || !state || Boolean(state.error)}>{busy ? 'Uploading…' : 'Upload file'}</button></form><p role="status" className="message">{message}</p><div className="filelist">{files.length === 0 ? <p className="muted">Uploaded and generated files will appear here.</p> : files.map(f => <article className="file" key={f.id}><div><strong>{f.filename}</strong><span>{f.kind} · {Math.round(f.bytes / 1024)} KiB</span><code>{f.id}</code></div><a className="button secondary" href={f.download_path} download>Download</a>{f.mime_type?.startsWith('video/') && <video controls preload="none" src={f.download_path}/>}{f.mime_type?.startsWith('audio/') && <audio controls preload="none" src={f.download_path}/>}</article>)}</div>{cursor && <button className="subtle" onClick={() => loadFiles(cursor)}>Load more files</button>}</section><footer><p>{state?.limits?.generationAttemptsToday ?? 0} / {state?.limits?.generationsPerDay ?? 30} generation attempts today · 3 per minute · Up to 8,192 output tokens · Approved Omni video uses a separate 20,000-token cap</p><p>These are request safeguards, not a dollar budget. Google may charge timed-out requests. No automatic generation retries. Files remain private until cleanup is requested.</p><a href="https://ai.google.dev/gemini-api/docs" target="_blank" rel="noreferrer">Google GenAI documentation</a></footer></>}</main>;
}
