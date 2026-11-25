import { createContext, useContext, useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, ChevronRight, Check, AlertCircle } from "lucide-react";
import { supabase, managerAuthClient } from "./supabaseClient";
import * as db from "./db";

const ROLES = {
  manager:    { label: "League Manager" },
  captain:    { label: "Team Captain" },
  player:     { label: "Player" },
};

const AuthContext = createContext(null);
export function useAuth() {
  return useContext(AuthContext);
}

const managerProfileStorageKey = "iba-manager-impersonation-profile";

function decodeJwtClaims(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload));
  } catch {
    return {};
  }
}

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [authLoading, setAuthLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [previewProfile, setPreviewProfile] = useState(null);
  const [managerProfile, setManagerProfile] = useState(null);
  const [impersonationMode, setImpersonationMode] = useState(null);
  const [impersonationDialog, setImpersonationDialog] = useState(null);
  const dialogResolver = useRef(null);
  const authEventVersionRef = useRef(0);

  const showImpersonationAlert = (message) => {
    setImpersonationDialog({ type: "alert", message });
  };

  const showImpersonationConfirm = (message) => new Promise((resolve) => {
    dialogResolver.current = resolve;
    setImpersonationDialog({ type: "confirm", message });
  });

  const closeImpersonationDialog = (confirmed = false) => {
    const resolve = dialogResolver.current;
    dialogResolver.current = null;
    setImpersonationDialog(null);
    if (resolve) resolve(confirmed);
  };

  const clearManagerBackup = async () => {
    await managerAuthClient.auth.signOut({ scope: "local" });
    localStorage.removeItem(managerProfileStorageKey);
  };

  const restoreManagerSession = async ({ goToAccess = true } = {}) => {
    const { data: backupData, error: backupError } = await managerAuthClient.auth.getSession();
    if (backupError || !backupData.session) {
      showImpersonationAlert("The original manager session is unavailable. Sign out and sign back in to continue.");
      return false;
    }
    const { error } = await supabase.auth.setSession({
      access_token: backupData.session.access_token,
      refresh_token: backupData.session.refresh_token,
    });
    if (error) {
      showImpersonationAlert("Could not restore the manager session. " + error.message);
      return false;
    }
    await clearManagerBackup();
    setPreviewProfile(null);
    setManagerProfile(null);
    setImpersonationMode(null);
    if (goToAccess) navigate("/access");
    return true;
  };

  const startMimic = async (targetProfile, mode = "read_only") => {
    if (previewProfile || managerProfile || profile?.role !== "manager" || !targetProfile?.id ||
        targetProfile.id === profile.id || !targetProfile.is_active ||
        !["read_only", "update"].includes(mode)) return false;

    const targetName = [targetProfile.first_name, targetProfile.last_name].filter(Boolean).join(" ") ||
      targetProfile.username || "this user";
    const confirmed = await showImpersonationConfirm(
      mode === "read_only"
        ? `View ${targetName} in READ-ONLY mode? Database writes and write-capable RPCs will be rejected.`
        : `View and UPDATE as ${targetName}? Changes you save will affect this user's account and league data.`
    );
    if (!confirmed) return false;

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) return false;

    try {
      const { error: backupError } = await managerAuthClient.auth.setSession({
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
      });
      if (backupError) throw backupError;
      localStorage.setItem(managerProfileStorageKey, JSON.stringify(profile));

      const { data, error } = await supabase.functions.invoke("manager-impersonate", {
        body: { targetUserId: targetProfile.id, mode },
      });
      if (error || !data?.token_hash) throw error || new Error("The impersonation service did not return a sign-in token.");

      const { data: targetSessionData, error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: data.token_hash,
        type: "magiclink",
      });
      if (verifyError) throw verifyError;

      const claims = decodeJwtClaims(targetSessionData?.session?.access_token || "");
      if (claims.manager_impersonator_id !== sessionData.session.user.id ||
          claims.manager_impersonation_mode !== mode ||
          !claims.manager_impersonation_session_id) {
        throw new Error("The protected impersonation claims were not issued. Confirm the Supabase Auth access-token hook is enabled before trying again.");
      }

      setManagerProfile(profile);
      setPreviewProfile({ ...targetProfile });
      setImpersonationMode(mode);
      navigate("/");
      return true;
    } catch (error) {
      await restoreManagerSession({ goToAccess: false }).catch(() => {});
      console.error("Unable to start manager impersonation:", error);
      showImpersonationAlert(error?.message || "Unable to start impersonation.");
      return false;
    }
  };

  const stopMimic = async () => {
    const { error: auditError } = await supabase.functions.invoke("manager-impersonate", {
      body: { action: "end" },
    });
    const restored = await restoreManagerSession();
    if (restored && auditError) {
      showImpersonationAlert("Your manager session was restored, but the impersonation exit event could not be recorded.");
    }
    return restored;
  };

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      const currentSession = data.session;
      setSession(currentSession);

      if (currentSession) {
        const claims = decodeJwtClaims(currentSession.access_token || "");
        const isImpersonation = typeof claims.manager_impersonator_id === "string" &&
          typeof claims.manager_impersonation_session_id === "string" &&
          ["read_only", "update"].includes(claims.manager_impersonation_mode);

        if (isImpersonation) {
          const { data: managerData } = await managerAuthClient.auth.getSession();
          if (!managerData.session || managerData.session.user.id !== claims.manager_impersonator_id) {
            await supabase.auth.signOut({ scope: "local" });
            await clearManagerBackup();
            if (active) setSession(null);
          } else {
            let savedManagerProfile = null;
            try { savedManagerProfile = JSON.parse(localStorage.getItem(managerProfileStorageKey) || "null"); } catch {}
            if (active) {
              setManagerProfile(savedManagerProfile);
              setImpersonationMode(claims.manager_impersonation_mode);
            }
            const targetProfile = await db.getProfile(currentSession.user.id);
            if (active) {
              setProfile(targetProfile);
              setPreviewProfile(targetProfile);
            }
          }
        } else {
          await clearManagerBackup();
          const p = await db.getProfile(currentSession.user.id);
          if (active) setProfile(p);
        }
      } else {
        await clearManagerBackup();
        if (active) setProfile(null);
      }
      if (active) setAuthLoading(false);
    };

    initialize();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      if (!active) return;
      setSession(sess);
      if (!sess) {
        setPreviewProfile(null);
        setManagerProfile(null);
        setImpersonationMode(null);
        setProfile(null);
        return;
      }

      // Auth transitions can arrive back-to-back during impersonation start/exit.
      // Profile lookup is asynchronous, so an older event can otherwise finish
      // after the newer manager event and incorrectly restore previewProfile.
      const eventVersion = ++authEventVersionRef.current;
      const claims = decodeJwtClaims(sess.access_token || "");
      const isImpersonation = typeof claims.manager_impersonator_id === "string" &&
        typeof claims.manager_impersonation_session_id === "string" &&
        ["read_only", "update"].includes(claims.manager_impersonation_mode);

      // Clear impersonation state immediately when the new auth session is the
      // manager session. Do not leave stale previewProfile/managerProfile state
      // in place while the asynchronous profile lookup is pending.
      if (!isImpersonation) {
        setPreviewProfile(null);
        setManagerProfile(null);
        setImpersonationMode(null);
      }

      setTimeout(async () => {
        try {
          const p = await db.getProfile(sess.user.id);
          if (!active || eventVersion !== authEventVersionRef.current) return;
          setProfile(p);
          if (isImpersonation) {
            setPreviewProfile(p);
            setImpersonationMode(claims.manager_impersonation_mode);
          } else {
            setPreviewProfile(null);
            setManagerProfile(null);
            setImpersonationMode(null);
          }
        } catch (error) {
          console.error("Unable to refresh profile after auth change:", error);
        }
      }, 0);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const logout = async () => {
    if (previewProfile) {
      await supabase.functions.invoke("manager-impersonate", { body: { action: "end" } });
      const { data: backupData } = await managerAuthClient.auth.getSession();
      if (backupData.session) {
        await supabase.auth.setSession({
          access_token: backupData.session.access_token,
          refresh_token: backupData.session.refresh_token,
        });
      }
    }
    await clearManagerBackup();
    setPreviewProfile(null);
    setManagerProfile(null);
    setImpersonationMode(null);
    await supabase.auth.signOut();
    navigate("/");
  };

  const refreshProfile = async () => {
    if (!session) return;
    const p = await db.getProfile(session.user.id);
    setProfile(p);
  };

  if (authLoading) {
    return <div className="iba-auth"><style>{css}</style><Loader /></div>;
  }

  if (!session) {
    return (
      <div className="iba-auth">
        <style>{css}</style>
        <AuthHeader />
        <AuthScreens />
      </div>
    );
  }

  if (!profile) {
    return <div className="iba-auth"><style>{css}</style><div className="auth-empty">Setting up your account…</div></div>;
  }

  if (!profile.is_active) {
    return <div className="iba-auth"><style>{css}</style><div className="auth-empty">Your account has been deactivated. Contact your league manager.</div></div>;
  }

  const effectiveProfile = profile;
  return (
    <AuthContext.Provider value={{
      session, profile: effectiveProfile, realProfile: managerProfile ?? profile, previewProfile,
      isMimicking: !!previewProfile, impersonationMode, startMimic, stopMimic, logout, refreshProfile,
    }}>
      <div className={previewProfile ? "mimic-preview-mode" : undefined}>
        {children}
      </div>

      {impersonationDialog && (
        <div className="impersonation-overlay" role="presentation" onClick={() => closeImpersonationDialog(false)}>
          <div className="impersonation-dialog" role="dialog" aria-modal="true" aria-labelledby="impersonation-dialog-title" onClick={event => event.stopPropagation()}>
            <div id="impersonation-dialog-title" className="impersonation-dialog__title">{impersonationDialog.type === "confirm" ? "Confirm impersonation" : "Impersonation notice"}</div>
            <div className="impersonation-dialog__message">{impersonationDialog.message}</div>
            <div className="impersonation-dialog__actions">
              {impersonationDialog.type === "confirm" && <button type="button" onClick={() => closeImpersonationDialog(false)} className="btn-sm">Cancel</button>}
              <button type="button" onClick={() => closeImpersonationDialog(impersonationDialog.type === "confirm")} className="btn-primary">{impersonationDialog.type === "confirm" ? "Continue" : "OK"}</button>
            </div>
          </div>
        </div>
      )}

      {previewProfile && (
        <div className={`impersonation-banner impersonation-banner--${impersonationMode === "read_only" ? "readonly" : "update"}`}>
          <span className="impersonation-banner__copy">
            {impersonationMode === "read_only" ? "READ ONLY" : "VIEW & UPDATE"} · {previewProfile.first_name || previewProfile.username} · {impersonationMode === "read_only" ? "Database writes are blocked" : "Changes affect this account"}
          </span>
          <button type="button" className="btn-sm impersonation-banner__exit" onClick={stopMimic}>Exit</button>
        </div>
      )}
    </AuthContext.Provider>
  );
}

function PoolBallMark({ size = 28 }) {
  return (
    <svg className="auth-pool-ball" width={size} height={size} viewBox="0 0 64 64" aria-label="Pool 8-ball" role="img">
      <defs>
        <radialGradient id="authBallShade" cx="27%" cy="20%" r="78%">
          <stop offset="0%" stopColor="#686868" />
          <stop offset="38%" stopColor="#252525" />
          <stop offset="78%" stopColor="#080808" />
          <stop offset="100%" stopColor="#000000" />
        </radialGradient>
        <linearGradient id="authBallRim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#A7F3D0" />
          <stop offset="50%" stopColor="#5FCF9E" />
          <stop offset="100%" stopColor="#176B4A" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="29" fill="url(#authBallRim)" />
      <circle cx="32" cy="32" r="26.5" fill="url(#authBallShade)" />
      <ellipse cx="22" cy="15" rx="10" ry="5" fill="#FFFFFF" opacity=".13" transform="rotate(-28 22 15)" />
      <circle cx="32" cy="32" r="13.2" fill="#F8F7F2" />
      <text x="32" y="38" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="18" fontWeight="900" fill="#111111">8</text>
    </svg>
  );
}

function AuthHeader() {
  return (
    <div className="auth-header">
      <PoolBallMark size={30} />
      <div className="auth-header__title">IBA Pool App</div>
    </div>
  );
}

function AuthScreens() {
  const [screen, setScreen] = useState("login"); // "login" | "register"
  return screen === "login"
    ? <LoginScreen onRegister={() => setScreen("register")} />
    : <RegisterScreen onBack={() => setScreen("login")} />;
}

function LoginScreen({ onRegister }) {
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setError(""); setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) setError(error.message);
  };

  const handleGoogle = async () => {
    setError("");
    const ok = await db.signInWithGoogle(`${window.location.origin}/`);
    if (!ok) setError("Could not start Google sign-in.");
    // On success the browser navigates away to Google, so nothing further happens here.
  };

  return (
    <div className="auth-screen">
      <div className="auth-screen__icon" aria-hidden="true" />
      <div className="auth-screen__title">Welcome to the IBA Pool League App</div>
      <div className="auth-screen__sub">Please sign in or register using the options below.</div>
      <div className="auth-screen__spacer" />
      <button className="btn-secondary" onClick={handleGoogle} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        <GoogleIcon size={15}/> Continue with Google
      </button>
      <div style={{display:"flex",alignItems:"center",gap:10,color:"#5A5A5A",fontSize:11,fontWeight:700}}>
        <div style={{flex:1,height:1,background:"#2E2E2E"}}/>OR<div style={{flex:1,height:1,background:"#2E2E2E"}}/>
      </div>
      <div className="field"><Label>Email</Label>
        <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoCapitalize="none" />
      </div>
      <div className="field"><Label>Password</Label>
        <div className="input-wrap">
          <input className="input" type={showPw ? "text" : "password"} value={password}
            onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="Password" />
          <button className="input-eye" onClick={() => setShowPw(v => !v)}>{showPw ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
        </div>
      </div>
      {error && <ErrorMsg>{error}</ErrorMsg>}
      <button className="btn-primary" onClick={handleLogin} disabled={!email.trim() || !password || loading}>{loading ? "Signing in…" : "Sign In"}</button>
      <button className="btn-ghost" onClick={onRegister}>Have an invite code or need to register?</button>
    </div>
  );
}

function RegisterScreen({ onBack }) {
  const [bootstrap, setBootstrap] = useState(null); // null = checking, true/false once known
  const [code, setCode]         = useState("");
  const [codeValid, setCodeValid] = useState(null); // { role, team_id, team_name } or a bootstrap stand-in
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [phone, setPhone]       = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword]   = useState("");
  const [password2, setPassword2] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState("");
  const [notice, setNotice]     = useState("");
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    db.isBootstrapNeeded().then(needed => {
      setBootstrap(needed);
      // No accounts exist yet -- skip the invite-code step entirely and go
      // straight to the signup fields. The server-side trigger makes this
      // signup a manager automatically regardless of invite code.
      if (needed) setCodeValid({ role: "manager", team_id: null, team_name: null, isBootstrap: true });
    });
  }, []);

  const checkCode = async () => {
    setError("");
    const result = await db.validateInviteCode(code.trim());
    if (!result) { setError("Invalid or expired invite code."); return; }
    setCodeValid(result);
  };

  const skipCode = () => {
    setError(""); setCode("");
    setCodeValid({ role: "player", team_id: null, team_name: null, isSkipped: true });
  };

  const handleRegister = async () => {
    if (!firstName.trim() || !lastName.trim()) { setError("First and last name are required."); return; }
    if (!username.trim()) { setError("Username required."); return; }
    if (phone.trim() && phone.replace(/\D/g, "").length < 10) { setError("Enter a valid phone number."); return; }
    if (!email.trim()) { setError("Email required."); return; }
    if (password.length < 6) { setError("Password must be 6+ characters."); return; }
    if (password !== password2) { setError("Passwords don't match."); return; }
    setLoading(true);
    const taken = await db.isUsernameTaken(username.trim());
    if (taken) { setLoading(false); setError("Username taken."); return; }
    const { error } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { data: { invite_code: code.trim(), first_name: firstName.trim(), last_name: lastName.trim(), username: username.trim(), phone_number: phone.trim() } },
    });
    setLoading(false);
    if (error) {
      setError(error.message?.includes("PLAYER_ALREADY_CLAIMED")
        ? "This roster player number is already linked to another account. Ask your captain to verify that the roster entry is correct. If the existing account link is wrong, the league manager will need to resolve that exceptional conflict."
        : code.trim() && error.message?.toLowerCase().includes("database error")
          ? "Account creation failed. If you used a player invite code, verify that your first and last name match the IBA player record, then try again or ask your captain to check the roster name."
          : error.message);
      return;
    }
    setError("");
    setNotice("Account created. Check your email to confirm, then sign in.");
  };

  if (bootstrap === null) {
    return <div className="auth-screen"><Loader /></div>;
  }

  return (
    <div className="auth-screen">
      <button className="btn-back" onClick={onBack}><ChevronRight size={14} style={{transform:"rotate(180deg)"}} /> Back</button>
      <div className="auth-screen__title" style={{fontSize:22}}>Create Account</div>
      {notice ? (
        <div className="code-verified-badge"><Check size={13}/> {notice}</div>
      ) : !codeValid ? (
        <>
          <div className="auth-screen__sub">Enter your invite code</div>
          <div style={{fontSize:11,color:"#9A9A9A",lineHeight:1.5,marginBottom:10}}>
            Already on an IBA team roster? Ask your team captain for a player-specific code before registering. It connects your account to your existing player number and league history—don't create a second player entry. You can also register without a code and redeem one later from Profile.
          </div>
          <div className="field"><Label>Invite Code</Label>
            <input className="input input--code" value={code} onChange={e => setCode(e.target.value)} placeholder="XXXXXX" autoCapitalize="characters" />
          </div>
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <button className="btn-primary" onClick={checkCode} disabled={!code.trim()}>Verify Code</button>
          <button className="btn-ghost" onClick={skipCode}>I don't have a code</button>
        </>
      ) : (
        <>
          <div className="code-verified-badge" style={codeValid.isSkipped ? {background:"#2A2410",borderColor:"#7A5C10",color:"#F2C14E"} : undefined}>
            {codeValid.isBootstrap
              ? <><Check size={13}/> First account on this league — you'll be the League Manager.</>
              : codeValid.isSkipped
              ? <><AlertCircle size={13}/> No code — you'll have read-only access until your team captain or a league manager gives you a player-specific code to redeem from Profile.</>
              : <><Check size={13}/> Code verified — <strong>{ROLES[codeValid.role].label}</strong>{codeValid.team_name ? ` · ${codeValid.team_name}` : ""}</>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div className="field"><Label>First Name</Label><input className="input" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First name" autoComplete="given-name" /></div>
            <div className="field"><Label>Last Name</Label><input className="input" value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last name" autoComplete="family-name" /></div>
          </div>
          <div className="field"><Label>Username</Label>
            <input className="input" value={username} onChange={e => setUsername(e.target.value)} placeholder="Choose a username" autoCapitalize="none" />
          </div>
          <div className="field"><Label>Phone Number (optional)</Label>
            <input className="input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 555-5555" />
          </div>
          <div style={{fontSize:10.5,color:"#6A6A6A",lineHeight:1.5}}>A player-specific invite code links this account to an existing IBA player record and roster membership. If you already play, get the code from your team captain. If you skipped the code, redeem it later in Profile → Redeem Invite Code.</div>
          <div className="field"><Label>Email</Label>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoCapitalize="none" />
          </div>
          <div className="field"><Label>Password (6+ characters)</Label>
            <div className="input-wrap">
              <input className="input" type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} placeholder="Choose a password" />
              <button className="input-eye" onClick={() => setShowPw(v => !v)}>{showPw ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
            </div>
          </div>
          <div className="field"><Label>Confirm Password</Label>
            <input className="input" type="password" value={password2} onChange={e => setPassword2(e.target.value)} placeholder="Repeat password" />
          </div>
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <button className="btn-primary" onClick={handleRegister} disabled={!firstName.trim() || !lastName.trim() || !username || !email || !password || !password2 || loading}>{loading ? "Creating…" : "Create Account"}</button>
        </>
      )}
    </div>
  );
}

function GoogleIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.1 8 3.1l5.7-5.7C34.5 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.1 8 3.1l5.7-5.7C34.5 6.1 29.6 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.5 0 10.4-2.1 14.1-5.6l-6.5-5.5C29.4 34.6 26.9 35.5 24 35.5c-5.2 0-9.6-3.3-11.3-8l-6.6 5.1C9.5 39.6 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.8l6.5 5.5C39.9 37.5 44 31.7 44 24c0-1.2-.1-2.4-.4-3.5z"/>
    </svg>
  );
}

function Label({ children }) { return <div className="form-label">{children}</div>; }
function ErrorMsg({ children }) { return <div className="error-msg"><span>⚠</span> {children}</div>; }
function Loader() { return <div className="auth-loader">Loading…</div>; }

const css = `
@import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html,body{width:100%;overflow-x:hidden;}
.iba-auth{font-family:'Archivo',sans-serif;background:#0E0E0E;min-height:100vh;width:100%;max-width:480px;margin:0 auto;color:#FFF;}
.auth-loader{display:flex;align-items:center;justify-content:center;min-height:100vh;color:#9A9A9A;font-size:13px;}
.auth-empty{padding:40px 24px;text-align:center;color:#9A9A9A;font-size:13px;}
.auth-header{display:flex;align-items:center;gap:10px;background:#0B3D2E;background-image:radial-gradient(circle at 50% 0%,#0F4A37 0%,#0B3D2E 70%);padding:14px 16px;}
.auth-pool-ball{display:block;flex-shrink:0;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35));}
.auth-header__title{font-family:'Archivo Black',sans-serif;font-size:16px;color:#FFF;}
.auth-screen{display:flex;flex-direction:column;gap:14px;padding:32px 20px 24px;}
.auth-screen__icon{display:flex;justify-content:center;margin-bottom:4px;}
.auth-screen__title{font-family:'Archivo Black',sans-serif;font-size:22px;text-align:center;line-height:1.3;}
.auth-screen__sub{font-size:13px;color:#9A9A9A;text-align:center;}
.auth-screen__spacer{height:6px;}
.btn-back{display:inline-flex;align-items:center;gap:4px;background:none;border:none;color:#5FCF9E;font-family:'Archivo',sans-serif;font-size:13px;font-weight:600;cursor:pointer;padding:0;}
.code-verified-badge{display:flex;align-items:center;gap:7px;background:#16332A;border:1.5px solid #1F6B4A;color:#5FCF9E;font-size:12px;font-weight:600;padding:10px 12px;border-radius:10px;}
.field{display:flex;flex-direction:column;gap:5px;}
.form-label{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9A9A9A;}
.input{width:100%;background:#121212;border:1.5px solid #3A3A3A;border-radius:9px;padding:10px 12px;font-family:'Archivo',sans-serif;font-size:16px;color:#FFF;outline:none;}
.input:focus{border-color:#5FCF9E;}
.input--code{font-family:'JetBrains Mono',monospace;font-size:20px;letter-spacing:0.2em;text-align:center;text-transform:uppercase;}
.input-wrap{position:relative;}
.input-wrap .input{padding-right:40px;}
.input-eye{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:#6A6A6A;cursor:pointer;display:flex;align-items:center;}
.btn-primary{width:100%;background:#5FCF9E;color:#0B1F16;font-family:'Archivo',sans-serif;font-size:14px;font-weight:700;padding:13px;border-radius:10px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;}
.btn-primary:disabled{opacity:.35;cursor:not-allowed;}
.btn-secondary{width:100%;background:transparent;color:#E0E0E0;font-family:'Archivo',sans-serif;font-size:13px;font-weight:600;padding:11px;border-radius:10px;border:1.5px solid #3A3A3A;cursor:pointer;}
.btn-ghost{background:none;border:none;font-family:'Archivo',sans-serif;font-size:12px;font-weight:600;color:#5FCF9E;cursor:pointer;padding:4px 0;}
.error-msg{display:flex;align-items:center;gap:5px;font-size:11.5px;color:#F87171;font-weight:600;}

.impersonation-overlay{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.76);}
.impersonation-dialog{width:100%;max-width:420px;padding:18px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.55);color:#FFF;font-family:'Archivo',sans-serif;}
.impersonation-dialog__title{font-family:'Archivo Black',sans-serif;font-size:16px;line-height:1.25;margin-bottom:10px;color:#FFF;}
.impersonation-dialog__message{font-size:12.5px;line-height:1.55;color:#B8B8B8;white-space:pre-wrap;}
.impersonation-dialog__actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:18px;}
.impersonation-banner{position:fixed;z-index:2000;top:calc(66px + env(safe-area-inset-top, 0px));left:10px;right:10px;max-width:460px;margin:0 auto;padding:8px 10px;border:1px solid #2E2E2E;border-left:3px solid #5FCF9E;border-radius:10px;background:#141414;box-shadow:0 5px 20px rgba(0,0,0,.35);display:flex;align-items:center;gap:9px;color:#FFF;font-family:'Archivo',sans-serif;}
.impersonation-banner--readonly{border-left-color:#6FA8DC;}
.impersonation-banner--update{border-left-color:#F2C14E;}
.impersonation-banner__copy{flex:1;min-width:0;font-size:11px;line-height:1.4;font-weight:700;color:#E0E0E0;}
.impersonation-banner__exit{flex:0 0 auto;min-width:54px;justify-content:center;}
@media(max-width:380px){.impersonation-banner{left:7px;right:7px;padding:7px 8px;gap:6px}.impersonation-banner__copy{font-size:10px}}
`;
