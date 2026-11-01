import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Play, X } from "lucide-react";

const STORAGE_KEY = "iba-active-session-v1";
const ActiveSessionContext = createContext(null);

function readStoredSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function ActiveSessionProvider({ children }) {
  const [activeSession, setActiveSessionState] = useState(readStoredSession);
  const navigate = useNavigate();
  const location = useLocation();

  const setActiveSession = (next) => {
    setActiveSessionState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, updatedAt: Date.now() }));
      else localStorage.removeItem(STORAGE_KEY);
      return value ? { ...value, updatedAt: Date.now() } : null;
    });
  };
  const clearActiveSession = () => setActiveSession(null);

  useEffect(() => {
    if (activeSession?.type === "live" && activeSession.archived) clearActiveSession();
  }, [activeSession?.archived, activeSession?.type]);

  const value = useMemo(() => ({ activeSession, setActiveSession, clearActiveSession }), [activeSession]);
  const isViewingSession = activeSession?.route === location.pathname;
  return (
    <ActiveSessionContext.Provider value={value}>
      {children}
      {activeSession && !isViewingSession && (
        <div style={{position:"fixed",zIndex:1000,left:12,right:12,bottom:"calc(76px + env(safe-area-inset-bottom, 0px))",maxWidth:620,margin:"0 auto",background:"#173A2B",border:"1px solid #3D8A67",borderRadius:14,boxShadow:"0 8px 28px rgba(0,0,0,.38)",padding:"10px 12px",display:"flex",alignItems:"center",gap:10,color:"#fff"}}>
          <div style={{width:34,height:34,borderRadius:10,background:"#24563F",display:"grid",placeItems:"center",flexShrink:0}}><Play size={16}/></div>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:12,fontWeight:800,lineHeight:1.3}}>{activeSession.type === "practice" ? "Practice session in progress" : "Live match in progress"}</div>
            <div style={{fontSize:11,color:"#C5E3D3",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{activeSession.title}{activeSession.subtitle ? " · " + activeSession.subtitle : ""}</div>
          </div>
          <button type="button" onClick={() => navigate(activeSession.route)} style={{border:0,borderRadius:9,padding:"9px 12px",background:"#5FCF9E",color:"#082719",fontWeight:800,fontSize:12,cursor:"pointer"}}>Resume</button>
          {activeSession.type === "practice" && <button type="button" aria-label="End practice session" title="End practice session" onClick={() => { if (window.confirm("End this unfinished practice session? Its unsaved score will be discarded.")) clearActiveSession(); }} style={{border:0,background:"transparent",color:"#D5E9DF",padding:5,cursor:"pointer"}}><X size={17}/></button>}
        </div>
      )}
    </ActiveSessionContext.Provider>
  );
}

export function useActiveSession() {
  const value = useContext(ActiveSessionContext);
  if (!value) throw new Error("useActiveSession must be used inside ActiveSessionProvider");
  return value;
}
