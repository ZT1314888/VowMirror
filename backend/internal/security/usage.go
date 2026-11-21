package security

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

const SuccessLimit = 5
const DefaultDailyAttemptLimit = 10

// UsageLedger stores only SHA-256 principals and counters, never codes or images.
// Generation holds per-principal admission from Check through RecordSuccess.
type UsageLedger struct {
	db         *sql.DB
	dailyLimit int
	now        func() time.Time
}

func OpenUsageLedger(path string, dailyLimit int) (*UsageLedger, error) {
	if path == "" || dailyLimit <= 0 {
		return nil, fmt.Errorf("用量数据库路径和每日尝试上限必须有效")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("打开用量数据库失败: %w", err)
	}
	db.SetMaxOpenConns(1)
	q := &UsageLedger{db: db, dailyLimit: dailyLimit, now: time.Now}
	for _, statement := range []string{
		"PRAGMA busy_timeout = 5000",
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = FULL",
		`CREATE TABLE IF NOT EXISTS usage (principal_hash TEXT PRIMARY KEY, successes INTEGER NOT NULL DEFAULT 0 CHECK(successes BETWEEN 0 AND 5), attempt_day TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0))`,
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("初始化用量数据库失败: %w", err)
		}
	}
	return q, nil
}

func (q *UsageLedger) Close() error { return q.db.Close() }

func (q *UsageLedger) Check(ctx context.Context, principal string) (int, *APIError) {
	if principal == "" {
		return 0, ErrAuthRequired
	}
	var successes, attempts int
	var day string
	err := q.db.QueryRowContext(ctx, "SELECT successes, attempt_day, attempts FROM usage WHERE principal_hash = ?", principal).Scan(&successes, &day, &attempts)
	if err == sql.ErrNoRows {
		return SuccessLimit, nil
	}
	if err != nil {
		return 0, ErrUsageUnavailable
	}
	if successes >= SuccessLimit {
		return 0, ErrSuccessQuotaExceeded
	}
	if day == q.now().UTC().Format(time.DateOnly) && attempts >= q.dailyLimit {
		return SuccessLimit - successes, ErrDailyQuotaExceeded
	}
	return SuccessLimit - successes, nil
}

// RecordAttempt runs after request assembly, immediately before transport.
func (q *UsageLedger) RecordAttempt(ctx context.Context, principal string) *APIError {
	if principal == "" {
		return ErrAuthRequired
	}
	day := q.now().UTC().Format(time.DateOnly)
	result, err := q.db.ExecContext(ctx, `INSERT INTO usage (principal_hash, attempt_day, attempts) VALUES (?, ?, 1)
		ON CONFLICT(principal_hash) DO UPDATE SET attempt_day = excluded.attempt_day,
		attempts = CASE WHEN usage.attempt_day = excluded.attempt_day THEN usage.attempts + 1 ELSE 1 END
		WHERE usage.successes < ? AND (usage.attempt_day != excluded.attempt_day OR usage.attempts < ?)`, principal, day, SuccessLimit, q.dailyLimit)
	if err != nil {
		return ErrUsageUnavailable
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return ErrUsageUnavailable
	}
	if changed == 1 {
		return nil
	}
	_, apiError := q.Check(ctx, principal)
	if apiError != nil {
		return apiError
	}
	return ErrUsageUnavailable
}

// Commit defines success; a later disconnect cannot undo accounting.
func (q *UsageLedger) RecordSuccess(ctx context.Context, principal string) *APIError {
	result, err := q.db.ExecContext(ctx, "UPDATE usage SET successes = successes + 1 WHERE principal_hash = ? AND successes < ?", principal, SuccessLimit)
	if err != nil {
		return ErrUsageUnavailable
	}
	changed, err := result.RowsAffected()
	if err != nil || changed != 1 {
		return ErrUsageUnavailable
	}
	return nil
}
