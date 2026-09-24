# FocusFlow judge: a thinking model behind an OpenAI-compatible API.
# Runs on a free Hugging Face Space (Docker SDK, CPU basic) or on any Docker host,
# e.g. an Oracle Cloud Always Free VM.
#
# Endpoint for the extension:  https://<username>-<space-name>.hf.space/v1
# Access token (recommended):  set LLAMA_API_KEY (a Space secret, or `docker run -e`)
#                              and paste the same value into FocusFlow → Settings.

FROM ghcr.io/ggml-org/llama.cpp:server

# Qwen3 is a thinking model. 1.7B is the default balance of speed and judgement;
# for faster answers on a slow CPU use Qwen3-0.6B, with a GPU or 4+ cores Qwen3-4B:
#   MODEL_URL=https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf
# (on Hugging Face, set it as a Space *variable*; locally, `docker build --build-arg MODEL_URL=...`).
ARG MODEL_URL=https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf

# Baked into the image so a sleeping Space wakes up without re-downloading it.
ADD ${MODEL_URL} /models/model.gguf
# Files fetched with ADD are root-only; Spaces run as a normal user.
RUN chmod 644 /models/model.gguf

# Spaces send traffic to port 7860.
EXPOSE 7860

# --parallel 2      a page you open never waits behind a background pre-judgement
# --cache-reuse     the long, fixed instructions are processed once, not per request
# --jinja + --reasoning-format deepseek
#                   Qwen3's chat template; thinking comes back separate from the answer
CMD ["--model", "/models/model.gguf", \
     "--alias", "qwen3", \
     "--host", "0.0.0.0", \
     "--port", "7860", \
     "--ctx-size", "8192", \
     "--parallel", "2", \
     "--cache-reuse", "256", \
     "--jinja", \
     "--reasoning-format", "deepseek"]
