import { createContext, useContext, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Eye, EyeOff, ChevronRight, Check, Shield, AlertCircle } from "lucide-react";
import { supabase } from "./supabaseClient";
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

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [authLoading, setAuthLoading] = useState(true);
  const [session, setSession]         = useState(null);
  const [profile, setProfile]         = useState(null);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) {
        const p = await db.getProfile(data.session.user.id);
        if (active) setProfile(p);
      }
      if (active) setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      setSession(sess);
      if (sess) {
        const p = await db.getProfile(sess.user.id);
        setProfile(p);
      } else {
        setProfile(null);
      }
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const logout = async () => {
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

  return (
    <AuthContext.Provider value={{ session, profile, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

function AuthHeader() {
  return (
    <div className="auth-header">
      <Shield size={14} color="#5FCF9E" />
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
      <div className="auth-screen__icon"><Lock size={26} color="#5FCF9E" /></div>
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
  const [username, setUsername] = useState("");
  const [phone, setPhone]       = useState("");
  const [playerNum, setPlayerNum] = useState("");
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
      options: { data: { invite_code: code.trim(), username: username.trim(), phone_number: phone.trim(), player_num: playerNum.trim() } },
    });
    setLoading(false);
    if (error) { setError(error.message); return; }
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
              ? <><AlertCircle size={13}/> No code — you'll have read-only access until a league manager gives you a code to redeem from your profile.</>
              : <><Check size={13}/> Code verified — <strong>{ROLES[codeValid.role].label}</strong>{codeValid.team_name ? ` · ${codeValid.team_name}` : ""}</>}
          </div>
          <div className="field"><Label>Username</Label>
            <input className="input" value={username} onChange={e => setUsername(e.target.value)} placeholder="Choose a username" autoCapitalize="none" />
          </div>
          <div className="field"><Label>Phone Number (optional)</Label>
            <input className="input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 555-5555" />
          </div>
          <div className="field"><Label>Player Number (optional)</Label>
            <input className="input" value={playerNum} onChange={e => setPlayerNum(e.target.value)} placeholder="If you already play in the league" />
            <div style={{fontSize:10.5,color:"#6A6A6A",marginTop:4}}>Shows your league stats & history. Don't have one, or not sure? Leave blank — you can add it later from your profile.</div>
          </div>
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
          <button className="btn-primary" onClick={handleRegister} disabled={!username || !email || !password || !password2 || loading}>{loading ? "Creating…" : "Create Account"}</button>
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
`;
