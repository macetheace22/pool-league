import { useEffect, useState } from "react";
import { Check, Edit2, Eye, EyeOff, Newspaper, Plus, Trash2, X } from "lucide-react";
import { useAuth } from "./AuthContext";
import { PageHeader, TabBar, shellCss, AccessDenied } from "./Shell";
import { css, Loader } from "./AdminApp";
import * as db from "./db";

export default function LeagueNewsManager() {
  const { profile, realProfile, isMimicking } = useAuth();
  const canManage = realProfile?.role === "manager" && !isMimicking;
  const [posts, setPosts] = useState(undefined);
  const [editing, setEditing] = useState(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [publishNow, setPublishNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    setPosts(undefined);
    try { setPosts(await db.listLeagueNewsForManager()); }
    catch (err) { setError(err.message || "Could not load league news."); setPosts([]); }
  };

  useEffect(() => { if (canManage) refresh(); }, [canManage]);

  const resetForm = () => {
    setEditing(null); setTitle(""); setBody(""); setPublishNow(true); setError(""); setNotice("");
  };
  const beginEdit = post => {
    setEditing(post);
    setTitle(post.title);
    setBody(post.body);
    setPublishNow(!!post.is_published);
    setError(""); setNotice("");
  };

  const save = async event => {
    event.preventDefault();
    setError(""); setNotice("");
    if (!title.trim() || !body.trim()) {
      setError("Enter both a headline and announcement.");
      return;
    }
    setSaving(true);
    try {
      await db.saveLeagueNews({
        ...(editing ?? {}),
        title, body, is_published: publishNow,
        published_at: publishNow ? editing?.published_at : null,
      }, realProfile.id);
      resetForm();
      setNotice(publishNow ? "Announcement published." : "Draft saved.");
      await refresh();
    } catch (err) {
      setError(err.message || "Could not save the announcement.");
    } finally { setSaving(false); }
  };

  const togglePublish = async post => {
    setError(""); setNotice("");
    try {
      await db.saveLeagueNews({ ...post, is_published: !post.is_published,
        published_at: post.is_published ? null : null }, realProfile.id);
      setNotice(post.is_published ? "Announcement moved to drafts." : "Announcement published.");
      await refresh();
    } catch (err) { setError(err.message || "Could not update the announcement."); }
  };

  const remove = async post => {
    if (!window.confirm(`Delete “${post.title}”? This cannot be undone.`)) return;
    setError(""); setNotice("");
    try {
      await db.deleteLeagueNews(post.id);
      if (editing?.id === post.id) resetForm();
      setNotice("Announcement deleted.");
      await refresh();
    } catch (err) { setError(err.message || "Could not delete the announcement."); }
  };

  if (!profile) return null;
  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style><style>{newsCss}</style>
      <PageHeader title="Manage League News" backFallback="/league-office" />
      <div className="tab-content">
        {!canManage ? <AccessDenied /> : (
          <>
            <div className="news-intro">Create announcements for league members. Save a draft to keep it private, or publish it to display it on the Leagues page.</div>
            <form className="news-editor" onSubmit={save}>
              <div className="news-editor__heading">
                <div className="news-editor__title"><Newspaper size={16}/>{editing ? "Edit announcement" : "New announcement"}</div>
                {editing && <button type="button" className="news-text-button" onClick={resetForm}><X size={14}/> Cancel edit</button>}
              </div>
              <label className="news-label" htmlFor="league-news-title">Headline</label>
              <input id="league-news-title" className="input" maxLength={160} value={title} onChange={e => setTitle(e.target.value)} placeholder="Announcement headline" />
              <label className="news-label" htmlFor="league-news-body">Announcement</label>
              <textarea id="league-news-body" className="input news-body" rows={5} value={body} onChange={e => setBody(e.target.value)} placeholder="Write the announcement for league members..." />
              <label className="news-publish-option">
                <input type="checkbox" checked={publishNow} onChange={e => setPublishNow(e.target.checked)} />
                Publish immediately
              </label>
              {error && <div className="news-message news-message--error">{error}</div>}
              {notice && <div className="news-message">{notice}</div>}
              <button type="submit" className="btn-primary" disabled={saving}>{saving ? "Saving..." : publishNow ? "Publish announcement" : "Save draft"}</button>
            </form>

            <div className="news-list-heading">Announcements</div>
            {posts === undefined ? <Loader /> : posts.length === 0 ? (
              <div className="empty-state">No announcements yet. Create a draft or publish your first league update above.</div>
            ) : posts.map(post => (
              <div className="news-post" key={post.id}>
                <div className="news-post__top">
                  <div className="news-post__headline">{post.title}</div>
                  <span className={`news-status ${post.is_published ? "news-status--published" : ""}`}>{post.is_published ? "Published" : "Draft"}</span>
                </div>
                <div className="news-post__body">{post.body}</div>
                <div className="news-post__actions">
                  <button type="button" className="news-action" onClick={() => beginEdit(post)}><Edit2 size={13}/> Edit</button>
                  <button type="button" className="news-action" onClick={() => togglePublish(post)}>
                    {post.is_published ? <><EyeOff size={13}/> Unpublish</> : <><Eye size={13}/> Publish</>}
                  </button>
                  <button type="button" className="news-action news-action--delete" onClick={() => remove(post)}><Trash2 size={13}/> Delete</button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      <TabBar />
    </div>
  );
}

const newsCss = `
.news-intro{font-size:12px;line-height:1.55;color:#A0A0A0;margin:0 0 14px;}
.news-editor{display:flex;flex-direction:column;gap:9px;background:#171717;border:1px solid #303030;border-radius:12px;padding:14px;margin-bottom:22px;}
.news-editor__heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;}
.news-editor__title{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:800;color:#F0F0F0;}
.news-label{font-size:11px;font-weight:700;color:#B8B8B8;margin-top:3px;}
.news-body{min-height:120px;resize:vertical;line-height:1.5;}
.news-publish-option{display:flex;align-items:center;gap:8px;font-size:12px;color:#D0D0D0;padding:4px 0;}
.news-publish-option input{accent-color:#5FCF9E;width:16px;height:16px;}
.news-editor .btn-primary{background:#126B46;border:1px solid #5FCF9E;color:#FFF;border-radius:8px;padding:10px 14px;font-size:12px;font-weight:800;cursor:pointer;}
.news-editor .btn-primary:disabled{opacity:.55;cursor:wait;}
.news-message{font-size:11px;color:#5FCF9E;}
.news-message--error{color:#FCA5A5;}
.news-text-button,.news-action{display:inline-flex;align-items:center;gap:5px;background:none;border:0;color:#9FC4B4;font-size:11px;font-weight:700;padding:6px;cursor:pointer;}
.news-list-heading{font-size:13px;font-weight:800;color:#EAEAEA;margin:0 0 9px;}
.news-post{border:1px solid #303030;border-radius:10px;padding:12px;margin-bottom:9px;background:#141414;}
.news-post__top{display:flex;align-items:flex-start;gap:8px;justify-content:space-between;}
.news-post__headline{font-size:13px;font-weight:800;color:#F0F0F0;min-width:0;overflow-wrap:anywhere;}
.news-status{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#B0B0B0;background:#292929;border-radius:5px;padding:4px 6px;white-space:nowrap;}
.news-status--published{color:#8DE0B8;background:#103D2B;}
.news-post__body{font-size:11.5px;color:#BDBDBD;line-height:1.55;white-space:pre-wrap;margin-top:8px;}
.news-post__actions{display:flex;flex-wrap:wrap;gap:5px;border-top:1px solid #292929;margin-top:10px;padding-top:7px;}
.news-action--delete{color:#FCA5A5;}
`;
