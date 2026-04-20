FROM denoland/deno:1.44.4

WORKDIR /app

COPY supabase/functions ./functions
COPY deno.json ./deno.json

RUN deno cache functions/*/index.ts

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "functions/connect/index.ts"]
