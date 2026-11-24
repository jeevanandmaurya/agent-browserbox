# Models

Choose the model in **Settings → Model**, or from the model name under the message box.

There are three places a model can run.

## API

A hosted model with your API key. Pick a service (**Anthropic**, **OpenAI**, **OpenRouter**, **Groq**, **Together**, **Mistral**, **Ollama Cloud**) or type any address that speaks the OpenAI protocol, add the key, then **Test connection** to list its models. Each service keeps its own key, stored encrypted in this browser and sent only to that service.

On Anthropic's API the agent can also search and read the web (server-side, so it is not limited by the browser). Some services (ollama.com among them) do not accept requests from web pages; see [Troubleshooting](troubleshooting) and the **Relay** setting.

## Local server

A model server on your machine or network: **Ollama**, **LM Studio**, **llama.cpp** or **vLLM**. The browser talks to it directly, so the server must allow this page:

- Ollama: start it with `OLLAMA_ORIGINS="*" ollama serve`
- LM Studio: turn on CORS in the server settings
- llama.cpp: `llama-server` allows it by default
- vLLM: `--allowed-origins '["*"]'`

Ollama's cloud models work this way too: run `ollama signin`, then use a model whose name ends in `-cloud`.

## In this browser

A small model that runs on your GPU (WebGPU) inside the tab. Nothing leaves your device and it works offline after the first download.

- **Download** a model from the list; each shows the GPU memory it needs and whether it fits phones.
- **Use** sets it as the model; it loads on your next message.
- **Delete** removes its files; **Free GPU memory** unloads it.
- **Import from a folder** takes a model you compiled with MLC.

Small models follow complex instructions less reliably and have a short memory (about 4,000 tokens): in long chats the oldest messages drop out of their view.

## Built into the browser

Some browsers ship their own small model (Chrome on desktop, version 138 or later, on devices with enough memory and disk space: Chrome's Prompt API). Choose **Built into the browser** in Settings → Model; the panel says whether this browser has it. Nothing to download yourself (the browser fetches its model once, on first use), no key, and it works offline. Like the WebGPU models it is small: good for questions and short tasks, and it cannot see images.
