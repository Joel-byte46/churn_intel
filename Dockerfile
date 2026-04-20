FROM denoland/deno:1.44.4

WORKDIR /app

COPY supabase/functions ./functions
COPY supabase/functions/deno.json ./deno.json
COPY supabase/functions/deno.lock ./deno.lock

RUN deno cache --lock=deno.lock functions/*/index.ts

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "functions/connect/index.ts"]
