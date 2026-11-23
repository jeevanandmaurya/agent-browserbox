# Models

Choose the model in **Settings → Model**, or from the model name under the message box.

## Claude

The default. Add an Anthropic API key (from console.anthropic.com). The key is stored encrypted in this browser and sent only to Anthropic. Claude can also search and read the web for the agent (server-side, so it is not limited by the browser).

## Local server

A model server on your machine or network: **Ollama**, **LM Studio**, **llama.cpp** or **vLLM**. The browser talks to it directly, so the server must allow this page:

- Ollama: start it with `OLLAMA_ORIGINS="*" ollama serve`
- LM Studio: turn on CORS in the server settings
- llama.cpp: `llama-server` allows it by default
- vLLM: `--allowed-origins '["*"]'`

Ollama's cloud models work this way too: run `ollama signin`, then use a model whose name ends in `-cloud`.

## OpenAI-compatible API

Hosted services that speak the OpenAI protocol: OpenAI, OpenRouter, Groq, Together, Mistral. They need an API key. Some services (ollama.com among them) do not accept requests from web pages; see [Troubleshooting](troubleshooting) and the **Relay** setting.

## In this browser

A small model that runs on your GPU (WebGPU) inside the tab. Nothing leaves your device and it works offline after the first download.

- **Download** a model from the list; each shows the GPU memory it needs and whether it fits phones.
- **Use** sets it as the model; it loads on your next message.
- **Delete** removes its files; **Free GPU memory** unloads it.
- **Import from a folder** takes a model you compiled with MLC.

Small models follow complex instructions less reliably and have a short memory (about 4,000 tokens): in long chats the oldest messages drop out of their view.
