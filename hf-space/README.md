---
title: FocusFlow Judge
emoji: 🎯
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: Qwen3 thinking model for the FocusFlow extension
---

# FocusFlow judge: your own free thinking model

This folder runs [llama.cpp](https://github.com/ggml-org/llama.cpp)'s OpenAI-compatible
server with **Qwen3**, a thinking model. The FocusFlow extension sends it a page's metadata
(title, description, YouTube category…) and it answers `ALLOW` or `BLOCK`.

It's yours: free, no daily limits, no third-party API.

## Option 1: Hugging Face Space (free, easiest)

1. Go to <https://huggingface.co/new-space>, pick **Docker** → **Blank**, hardware **CPU basic (free)**.
   Keep the Space **public** (see "Access token").
2. Upload `Dockerfile` and this `README.md`.
3. Wait for the build (a few minutes; it downloads the model once).
4. In FocusFlow → Settings, choose **Hugging Face Space**, set the server URL to
   `https://<your-username>-<space-name>.hf.space/v1` and the model to `qwen3`, then **Save**.

Speed: a free Space has 2 CPUs, so a new page takes roughly 10–30 s to judge with thinking.
FocusFlow hides most of that by judging the videos on your screen and the link under your mouse
**before** you click, and every verdict is remembered. For faster answers, set a Space variable
`MODEL_URL` to the Qwen3-0.6B file (see the Dockerfile) and restart the Space.

Free Spaces sleep after ~48 h without traffic. FocusFlow wakes the Space when the browser starts.

## Option 2: your own free server (about 2× faster)

[Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) includes an Ampere VM with
**4 CPUs and 24 GB RAM**, free with no usage limit (sign-up asks for a card for verification).

```bash
# on the VM (Ubuntu), after installing Docker:
git clone https://github.com/parthkansal823/FocusFlow && cd FocusFlow
docker build -t focusflow-llm hf-space
docker run -d --restart=always -p 7860:7860 -e LLAMA_API_KEY=<long-random-secret> focusflow-llm
```

Open port 7860 in the VM's security list and firewall, then in FocusFlow choose **Your server**:
URL `http://<vm-ip>:7860/v1`, model `qwen3`, access token `<long-random-secret>`.
With 4 cores, Qwen3-4B (`--build-arg MODEL_URL=...Qwen3-4B-Q4_K_M.gguf`) is also usable.

## Access token (recommended)

Anyone who knows the URL could use your server. Set `LLAMA_API_KEY`
(a **secret** in the Space settings, or `-e` with Docker) to any long random value and paste
the same value into FocusFlow's **Access token** field. (A *private* Space would need a
Hugging Face token in the same header, which llama.cpp can't check, so use a public
Space + `LLAMA_API_KEY`.)
