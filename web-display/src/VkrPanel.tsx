import { useEffect, useState } from "react";
import { request, downloadFeedbackReport } from "./api";
export const reasons: Record<string, string> = {
  food_quality: "Качество питания",
  service: "Обслуживание",
  availability: "Наличие блюд",
  information: "Информация о меню",
  other: "Другое",
};
const statusNames: Record<string, string> = {
  new: "Новое",
  in_progress: "В работе",
  closed: "Закрыто",
};
type RecordRow = Record<string, any>;
export function FeedbackForm() {
  useEffect(() => {
    document.title = "Обратная связь — InteractiveFoodMenu";
  }, []);
  const code = new URLSearchParams(location.search).get("venue") ?? "";
  const [venue, setVenue] = useState<RecordRow | null>(null),
    [message, setMessage] = useState(""),
    [category, setCategory] = useState("other"),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void request<RecordRow>(`/public/venues/${encodeURIComponent(code)}`)
      .then(setVenue)
      .catch((e) => setError(e.message));
  }, [code]);
  return (
    <main className="vkr-public">
      <section className="hub-card">
        <h1>Обратная связь</h1>
        {venue && <h2>{venue.name}</h2>}
        {sent ? (
          <p role="status">Спасибо. Обращение принято.</p>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                await request(
                  `/public/venues/${encodeURIComponent(code)}/reviews`,
                  {
                    method: "POST",
                    body: JSON.stringify({ message, category }),
                  },
                );
                setSent(true);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              Расскажите о ситуации. Имя и контактные данные не требуются. Не
              указывайте чужие персональные данные.
            </p>
            <label>
              Причина
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {Object.entries(reasons).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сообщение
              <textarea
                required
                maxLength={2000}
                rows={6}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <button disabled={busy || !venue || !message.trim()}>
              {busy ? "Отправляем…" : "Отправить"}
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="hub-error">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
function ReviewCard({
  row,
  token,
  onChanged,
  readOnly = false,
}: {
  row: RecordRow;
  token: string;
  onChanged: () => Promise<void>;
  readOnly?: boolean;
}) {
  const [assignees, setAssignees] = useState<RecordRow[]>([]);
  useEffect(() => {
    void request<{ accounts: RecordRow[] }>(
      `/hub/venues/${row.venueId}/assignees`,
      {},
      token,
    )
      .then((r) => setAssignees(r.accounts))
      .catch((e) => setError(e.message));
  }, [row.venueId, token]);
  const [category, setCategory] = useState(row.category),
    [status, setStatus] = useState(row.status),
    [comment, setComment] = useState(""),
    [assignedTo, setAssignedTo] = useState(row.assignedTo ?? ""),
    [history, setHistory] = useState<RecordRow[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setCategory(row.category);
    setStatus(row.status);
    setAssignedTo(row.assignedTo ?? "");
  }, [row]);
  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="hub-card vkr-review">
      <div className="hub-card-title">
        <h3>{statusNames[row.status]}</h3>
        <time>{new Date(row.createdAt).toLocaleString("ru-RU")}</time>
      </div>
      <p className="vkr-message">{row.message}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (readOnly) return;
          void action(async () => {
            await request(
              `/hub/reviews/${encodeURIComponent(row.id)}`,
              {
                method: "PATCH",
                body: JSON.stringify({
                  version: row.version,
                  category,
                  status,
                  comment,
                  ...(assignedTo ? { assignedTo } : {}),
                }),
              },
              token,
            );
            setComment("");
            setHistory(null);
            await onChanged();
          });
        }}
      >
        <div className="vkr-fields">
          <label>
            Причина
            <select
              disabled={readOnly}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {Object.entries(reasons).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Статус
            <select
              disabled={readOnly}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {Object.entries(statusNames).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Ответственный
          <select
            disabled={readOnly}
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
          >
            <option value="">Назначить себя</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Действие и результат
          <textarea
            disabled={readOnly}
            required
            maxLength={2000}
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
        <div className="vkr-fields">
          <button disabled={readOnly || busy || !comment.trim()}>
            Сохранить действие
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () =>
                setHistory(
                  (
                    await request<{ actions: RecordRow[] }>(
                      `/hub/reviews/${row.id}/actions`,
                      {},
                      token,
                    )
                  ).actions,
                ),
              )
            }
          >
            История
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="hub-error">
          {error}
        </p>
      )}
      {history && (
        <ol>
          {history.map((h) => (
            <li key={h.id}>
              <b>{h.actorName ?? "Сотрудник"}</b> ·{" "}
              {new Date(h.createdAt).toLocaleString("ru-RU")}
              <p>
                {statusNames[JSON.parse(h.beforeJson).status]} →{" "}
                {statusNames[JSON.parse(h.afterJson).status]} · {h.comment}
              </p>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
export function VkrPanel({ token }: { token: string }) {
  const [scope, setScope] = useState<RecordRow | null>(null),
    [reviews, setReviews] = useState<RecordRow[]>([]),
    [report, setReport] = useState<RecordRow | null>(null),
    [accounts, setAccounts] = useState<RecordRow[]>([]),
    [grants, setGrants] = useState<RecordRow[]>([]);
  const [venueId, setVenueId] = useState(""),
    [from, setFrom] = useState(
      new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [orgName, setOrgName] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [operatorId, setOperatorId] = useState(""),
    [organizationId, setOrganizationId] = useState(""),
    [grantVenue, setGrantVenue] = useState(""),
    [role, setRole] = useState("manager");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const query = `?from=${from}&to=${to}${venueId ? `&venueId=${encodeURIComponent(venueId)}` : ""}`;
  const refresh = async () => {
    const access = await request<RecordRow>("/hub/vkr/access", {}, token);
    setScope(access);
    const [r, p] = await Promise.all([
      request<{ reviews: RecordRow[] }>(`/hub/reviews${query}`, {}, token),
      request<RecordRow>(`/hub/reports/feedback${query}`, {}, token),
    ]);
    setReviews(r.reviews);
    setReport(p);
    if (access.admin) {
      const data = await request<RecordRow>("/hub/accounts", {}, token);
      setAccounts(data.accounts);
      setGrants(data.grants);
    }
  };
  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void action(refresh);
  }, [token]);
  return (
    <section className="vkr-panel" aria-label="Обращения и доступ">
      <section className="hub-card">
        <h3>Обращения и отчёт</h3>
        <div className="vkr-fields">
          <label>
            Точка
            <select
              value={venueId}
              onChange={(e) => setVenueId(e.target.value)}
            >
              <option value="">Все доступные</option>
              {scope?.venues.map((v: RecordRow) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            С
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            По
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button disabled={busy} onClick={() => void action(refresh)}>
            Применить
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void action(() => downloadFeedbackReport(query, token))
            }
          >
            Скачать CSV
          </button>
        </div>
        {report && (
          <>
            <p>
              Обращений за выбранный период: <b>{report.total}</b>
            </p>
            <div className="hub-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Точка</th>
                    <th>Причина</th>
                    <th>Всего</th>
                    <th>Новые</th>
                    <th>В работе</th>
                    <th>Закрыты</th>
                  </tr>
                </thead>
                <tbody>
                  {report.groups.map((g: RecordRow) => (
                    <tr key={`${g.venueId}:${g.category}`}>
                      <td>{g.venueName}</td>
                      <td>{reasons[g.category]}</td>
                      <td>{g.total}</td>
                      <td>{g.new}</td>
                      <td>{g.inProgress}</td>
                      <td>{g.closed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {scope?.venues.map((v: RecordRow) => (
          <p key={v.id}>
            <a
              href={`/feedback?venue=${encodeURIComponent(v.code)}`}
              target="_blank"
              rel="noreferrer"
            >
              Форма обратной связи — {v.name}
            </a>
          </p>
        ))}
      </section>
      {error && (
        <p role="alert" className="hub-error">
          {error}
        </p>
      )}
      {reviews.map((row) => (
        <ReviewCard
          key={row.id}
          row={row}
          token={token}
          onChanged={refresh}
          readOnly={
            !scope?.admin &&
            !scope?.grants.some(
              (g: RecordRow) =>
                g.role === "manager" &&
                g.organizationId ===
                  scope.venues.find((v: RecordRow) => v.id === row.venueId)
                    ?.organizationId &&
                (!g.venueId || g.venueId === row.venueId),
            )
          }
        />
      ))}
      {!busy && !reviews.length && <p>За выбранный период обращений нет.</p>}
      {scope?.admin && (
        <section className="hub-card">
          <h3>Организации и права</h3>
          <p>
            Новые аккаунты получают доступ после назначения роли. Управляющий
            изменяет данные, аудитор просматривает их.
          </p>
          <form
            className="vkr-fields"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await request(
                  "/hub/organizations",
                  { method: "POST", body: JSON.stringify({ name: orgName }) },
                  token,
                );
                setOrgName("");
                await refresh();
              });
            }}
          >
            <label>
              Название организации
              <input
                required
                maxLength={160}
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
              />
            </label>
            <button disabled={busy}>Добавить организацию</button>
          </form>
          <form
            className="vkr-fields"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await request(
                  "/hub/accounts",
                  {
                    method: "POST",
                    body: JSON.stringify({ username, password }),
                  },
                  token,
                );
                setPassword("");
                setUsername("");
                await refresh();
              });
            }}
          >
            <label>
              Логин
              <input
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label>
              Начальный пароль
              <input
                required
                autoComplete="new-password"
                type="password"
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button disabled={busy}>Создать аккаунт</button>
          </form>
          <form
            className="vkr-fields"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await request(
                  "/hub/grants",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      operatorId,
                      organizationId,
                      role,
                      ...(grantVenue ? { venueId: grantVenue } : {}),
                    }),
                  },
                  token,
                );
                await refresh();
              });
            }}
          >
            <label>
              Аккаунт
              <select
                required
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
              >
                <option value="">Выберите</option>
                {accounts.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.username}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Организация
              <select
                required
                value={organizationId}
                onChange={(e) => {
                  setOrganizationId(e.target.value);
                  setGrantVenue("");
                }}
              >
                <option value="">Выберите</option>
                {scope.organizations.map((o: RecordRow) => (
                  <option value={o.id} key={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Область
              <select
                value={grantVenue}
                onChange={(e) => setGrantVenue(e.target.value)}
              >
                <option value="">Все точки организации</option>
                {scope.venues
                  .filter((v: RecordRow) => v.organizationId === organizationId)
                  .map((v: RecordRow) => (
                    <option value={v.id} key={v.id}>
                      {v.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Роль
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="manager">Управляющий</option>
                <option value="auditor">Аудитор</option>
              </select>
            </label>
            <button disabled={busy}>Назначить</button>
          </form>
          <ul>
            {grants.map((g) => (
              <li key={g.id}>
                {accounts.find((a) => a.id === g.operatorId)?.username} ·{" "}
                {
                  scope.organizations.find(
                    (o: RecordRow) => o.id === g.organizationId,
                  )?.name
                }{" "}
                · {g.role === "manager" ? "Управляющий" : "Аудитор"} ·{" "}
                {g.venueId
                  ? scope.venues.find((v: RecordRow) => v.id === g.venueId)
                      ?.name
                  : "Все точки"}{" "}
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await request(
                        `/hub/grants/${g.id}`,
                        { method: "DELETE" },
                        token,
                      );
                      await refresh();
                    })
                  }
                >
                  Отозвать
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
