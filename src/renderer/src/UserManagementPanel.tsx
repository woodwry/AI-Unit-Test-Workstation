import { Pencil, Plus, RefreshCw, Search, Trash2, UserRoundCog, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AdminUser, AuthUser } from '../../shared/auth-contracts';

type UserManagementPanelProps = Readonly<{ currentUser: AuthUser }>;
type EditorMode = Readonly<{ kind: 'create' }> | Readonly<{ kind: 'edit'; user: AdminUser }>;

export function UserManagementPanel({ currentUser }: UserManagementPanelProps): JSX.Element {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<EditorMode | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setUsers(await window.workstation.listUsers());
    } catch {
      setError('用户列表加载失败，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return users;
    return users.filter((user) =>
      user.loginName.toLocaleLowerCase().includes(keyword)
      || roleLabel(user.role).includes(keyword)
      || availabilityLabel(user.isAvailable).includes(keyword)
    );
  }, [query, users]);

  const remove = useCallback(async (user: AdminUser): Promise<void> => {
    if (user.id === currentUser.id) return;
    if (!window.confirm(`确定删除账号“${user.loginName}”吗？此操作不可撤销。`)) return;
    try {
      await window.workstation.deleteUser({ id: user.id });
      await load();
    } catch (failure) {
      setError(readError(failure, '删除用户失败。'));
    }
  }, [currentUser.id, load]);

  return (
    <section className="user-management-panel">
      <header>
        <div>
          <h2>用户管理</h2>
          <span>{users.length} 个账号</span>
        </div>
        <div className="user-management-actions">
          <button type="button" title="刷新" onClick={() => void load()}><RefreshCw size={14} /></button>
          <button type="button" title="新增用户" onClick={() => setEditor({ kind: 'create' })}><Plus size={15} /></button>
        </div>
      </header>
      <label className="user-management-search">
        <Search size={14} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户" />
      </label>
      {error && <div className="user-management-error" role="alert">{error}</div>}
      <div className="user-management-list">
        {loading ? (
          <div className="user-management-empty">正在加载用户…</div>
        ) : filtered.length === 0 ? (
          <div className="user-management-empty">没有匹配的用户</div>
        ) : filtered.map((user) => {
          const self = user.id === currentUser.id;
          return (
            <article className="user-management-item" key={user.id}>
              <div className="user-management-avatar"><UserRoundCog size={16} /></div>
              <div className="user-management-summary">
                <div className="user-management-name">
                  <strong>{user.loginName}</strong>
                  {self && <small>当前账号</small>}
                </div>
                <div className="user-management-badges">
                  <span>{roleLabel(user.role)}</span>
                  <span className={user.isAvailable === 1 ? 'available' : 'disabled'}>
                    {availabilityLabel(user.isAvailable)}
                  </span>
                </div>
                <dl>
                  <div><dt>登录</dt><dd>{user.loginCount} 次</dd></div>
                  <div><dt>任务</dt><dd>{user.taskExecutionCount} 次</dd></div>
                  <div><dt>最近</dt><dd>{formatDate(user.lastLoginAt)}</dd></div>
                  <div><dt>IP</dt><dd>{user.lastLoginIp ?? '—'}</dd></div>
                </dl>
              </div>
              <div className="user-management-row-actions">
                <button type="button" title="编辑" onClick={() => setEditor({ kind: 'edit', user })}>
                  <Pencil size={13} />
                </button>
                <button type="button" title={self ? '不能删除当前账号' : '删除'} disabled={self} onClick={() => void remove(user)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {editor && (
        <UserEditor
          mode={editor}
          currentUserId={currentUser.id}
          onClose={() => setEditor(null)}
          onSaved={async () => { setEditor(null); await load(); }}
        />
      )}
    </section>
  );
}

function UserEditor({
  mode,
  currentUserId,
  onClose,
  onSaved
}: Readonly<{
  mode: EditorMode;
  currentUserId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}>): JSX.Element {
  const editing = mode.kind === 'edit' ? mode.user : null;
  const self = editing?.id === currentUserId;
  const [loginName, setLoginName] = useState(editing?.loginName ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'USER'>(editing?.role ?? 'USER');
  const [isAvailable, setIsAvailable] = useState<0 | 1>(editing?.isAvailable ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editing) {
        await window.workstation.updateUser({
          id: editing.id,
          loginName,
          role,
          isAvailable,
          ...(password ? { password } : {})
        });
      } else {
        await window.workstation.createUser({ loginName, password, role, isAvailable });
      }
      await onSaved();
    } catch (failure) {
      setError(readError(failure, '保存用户失败。'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="user-editor-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="user-editor" onSubmit={(event) => void save(event)} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h3>{editing ? '编辑用户' : '新增用户'}</h3>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </header>
        <label><span>登录名</span><input autoFocus value={loginName} maxLength={255} onChange={(event) => setLoginName(event.target.value)} /></label>
        <label>
          <span>{editing ? '重置密码（留空则不修改）' : '初始密码'}</span>
          <input type="password" autoComplete="new-password" value={password} maxLength={1024} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label><span>角色</span><select value={role} disabled={self} onChange={(event) => setRole(event.target.value as 'ADMIN' | 'USER')}><option value="USER">普通用户</option><option value="ADMIN">管理员</option></select></label>
        <label><span>账号状态</span><select value={isAvailable} disabled={self} onChange={(event) => setIsAvailable(Number(event.target.value) as 0 | 1)}><option value={1}>可用</option><option value={0}>停用</option></select></label>
        {error && <div className="user-management-error" role="alert">{error}</div>}
        <footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? '正在保存…' : '保存'}</button></footer>
      </form>
    </div>
  );
}

function roleLabel(role: AdminUser['role']): string { return role === 'ADMIN' ? '管理员' : '普通用户'; }
function availabilityLabel(value: AdminUser['isAvailable']): string { return value === 1 ? '可用' : '已停用'; }
function formatDate(value: string | null): string {
  if (!value) return '从未登录';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
function readError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  for (const known of ['登录名已存在', '不能停用当前管理员账号', '不能取消当前管理员权限', '不能删除当前管理员账号', '系统必须至少保留一个管理员账号']) {
    if (message.includes(known)) return `${known}。`;
  }
  return fallback;
}
