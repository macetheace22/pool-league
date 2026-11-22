import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigins = (Deno.env.get("APP_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean);

const corsHeadersFor = (origin: string | null) => ({
  ...(origin && allowedOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req.headers.get("Origin")), "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (!origin || !allowedOrigins.includes(origin)) return json({ error: "Origin is not allowed" }, 403);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Server configuration is incomplete" }, 500);

  const token = authorization.slice("Bearer ".length);
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "Invalid manager session" }, 401);

  let body: { targetUserId?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const targetUserId = body.targetUserId;
  if (!targetUserId || typeof targetUserId !== "string" || targetUserId === authData.user.id) {
    return json({ error: "A different target account is required" }, 400);
  }

  const { data: manager, error: managerError } = await admin
    .from("profiles").select("id, role, is_active").eq("id", authData.user.id).maybeSingle();
  if (managerError || !manager || manager.role !== "manager" || !manager.is_active) {
    return json({ error: "Only an active league manager may impersonate another account" }, 403);
  }

  const { data: target, error: targetError } = await admin
    .from("profiles").select("id, is_active").eq("id", targetUserId).maybeSingle();
  if (targetError || !target || !target.is_active) return json({ error: "Target account is unavailable" }, 404);

  const { data: targetAuth, error: targetAuthError } = await admin.auth.admin.getUserById(targetUserId);
  const email = targetAuth.user?.email;
  if (targetAuthError || !email) return json({ error: "Target account has no sign-in email" }, 409);

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) return json({ error: "Could not create a temporary target session" }, 500);

  const { error: auditError } = await admin.from("manager_impersonation_events").insert({
    manager_profile_id: manager.id,
    target_profile_id: target.id,
    event_type: "started",
  });
  if (auditError) return json({ error: "Could not record the impersonation event" }, 500);

  return json({ token_hash: tokenHash });
});
