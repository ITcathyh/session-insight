package sessionstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func apiError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func (e *Store) importFiles(w http.ResponseWriter, r *http.Request) {
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		apiError(w, 400, "multipart files required")
		return
	}
	mr := multipart.NewReader(http.MaxBytesReader(w, r.Body, maxImportBytes+int64(maxImportFiles)*1024), params["boundary"])
	tmp, err := os.MkdirTemp("", "session-insight-import-")
	if err != nil {
		apiError(w, 500, "create import staging")
		return
	}
	defer os.RemoveAll(tmp)
	if err := os.Chmod(tmp, 0700); err != nil {
		apiError(w, 500, "secure import staging")
		return
	}
	var staged []stagedFile
	var total int64
	var relativePath string
	hasRelativePath := false
	for {
		part, nextErr := mr.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			apiError(w, 400, "invalid multipart data")
			return
		}
		if part.FormName() == "relativePath" {
			if hasRelativePath {
				part.Close()
				apiError(w, 400, "relative path must precede one file")
				return
			}
			value, readErr := io.ReadAll(io.LimitReader(part, 4097))
			part.Close()
			if readErr != nil || len(value) > 4096 {
				apiError(w, 400, "invalid relative path")
				return
			}
			relativePath = string(value)
			hasRelativePath = true
			continue
		}
		if part.FormName() != "files" || part.FileName() == "" {
			part.Close()
			continue
		}
		if len(staged) >= maxImportFiles {
			part.Close()
			apiError(w, 413, "too many files")
			return
		}
		fileName := part.FileName()
		path := filepath.Join(tmp, fmt.Sprintf("upload-%d.jsonl", len(staged)))
		file, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if createErr != nil {
			part.Close()
			apiError(w, 500, "stage upload")
			return
		}
		written, copyErr := copyLimit(file, part, maxImportBytes-total)
		closeErr := file.Close()
		part.Close()
		total += written
		if copyErr != nil || closeErr != nil {
			if errors.Is(copyErr, errLimit) {
				apiError(w, 413, "import exceeds byte limit")
			} else {
				apiError(w, 400, "read upload")
			}
			return
		}
		provider, detectErr := detectProvider(path)
		if detectErr != nil {
			apiError(w, 400, "unrecognized session format")
			return
		}
		pathValue := relativePath
		if !hasRelativePath || pathValue == "" {
			pathValue = fileName
		}
		safePath, pathErr := safeRelativePath(pathValue)
		if pathErr != nil {
			apiError(w, 400, "invalid relative path")
			return
		}
		staged = append(staged, stagedFile{path: path, provider: provider, relativePath: safePath})
		hasRelativePath = false
		relativePath = ""
	}
	if hasRelativePath {
		apiError(w, 400, "relative path has no file")
		return
	}
	if len(staged) == 0 {
		apiError(w, 400, "files required")
		return
	}
	result, err := e.scanStaged(r.Context(), tmp, staged)
	if err != nil {
		apiError(w, 400, "analyze import: "+err.Error())
		return
	}
	if len(result.Runs) == 0 {
		apiError(w, http.StatusBadRequest, "analyze import: no session records found")
		return
	}
	stored, err := e.upsert(result.Runs, "import")
	if err != nil {
		apiError(w, 500, "save local index")
		return
	}
	views := make([]RunView, len(stored.Runs))
	for i, run := range stored.Runs {
		views[i] = publicRun(run)
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": views, "count": len(views), "imported": stored.Imported, "updated": stored.Updated, "filesScanned": result.FilesScanned, "filesSkipped": result.FilesSkipped, "warnings": result.Warnings})
}

type stagedFile struct{ path, provider, relativePath string }

func safeRelativePath(raw string) (string, error) {
	if raw == "" || strings.ContainsRune(raw, '\x00') {
		return "", errors.New("empty or invalid path")
	}
	normalized := strings.ReplaceAll(raw, "\\", "/")
	if strings.HasPrefix(normalized, "/") || filepath.IsAbs(raw) {
		return "", errors.New("absolute path")
	}
	cleaned := filepath.Clean(filepath.FromSlash(normalized))
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errors.New("path traversal")
	}
	return cleaned, nil
}

func (e *Store) scanStaged(ctx context.Context, tmp string, files []stagedFile) (sessioninsight.ScanResult, error) {
	codexRoot := filepath.Join(tmp, "codex")
	claudeRoot := filepath.Join(tmp, "claude")
	traeRoot := filepath.Join(tmp, "traex")
	seen := make(map[string]struct{}, len(files))
	for _, file := range files {
		var dest string
		switch file.provider {
		case "codex":
			dest = filepath.Join(codexRoot, "sessions", "import", file.relativePath)
		case "claude":
			dest = filepath.Join(claudeRoot, "projects", "import", file.relativePath)
		case "traex":
			dest = filepath.Join(traeRoot, "cli", "sessions", "import", file.relativePath)
		default:
			return sessioninsight.ScanResult{}, errors.New("unknown provider")
		}
		if _, duplicate := seen[dest]; duplicate {
			return sessioninsight.ScanResult{}, errors.New("duplicate relative path")
		}
		seen[dest] = struct{}{}
		if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
			return sessioninsight.ScanResult{}, err
		}
		if err := os.Rename(file.path, dest); err != nil {
			return sessioninsight.ScanResult{}, err
		}
	}
	result, err := sessioninsight.Scan(ctx, sessioninsight.ScanOptions{CodexRoot: codexRoot, ClaudeRoot: claudeRoot, TraeRoot: traeRoot, MaxFiles: maxImportFiles, MaxTotalBytes: maxImportBytes, MaxLineBytes: maxImportLineBytes, Now: e.now()})
	if err != nil {
		return sessioninsight.ScanResult{}, err
	}
	return result, nil
}

func (e *Store) scan(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Days      int      `json:"days"`
		Providers []string `json:"providers"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
			apiError(w, 400, "invalid request")
			return
		}
	}
	if request.Days < 0 || request.Days > 3650 {
		apiError(w, 400, "invalid days")
		return
	}
	result, err := sessioninsight.Scan(r.Context(), sessioninsight.ScanOptions{Days: request.Days, Providers: request.Providers, Now: e.now()})
	if err != nil {
		apiError(w, 500, "scan local sessions")
		return
	}
	stored, err := e.upsert(result.Runs, "scan")
	if err != nil {
		apiError(w, 500, "save local index")
		return
	}
	views := make([]RunView, len(stored.Runs))
	for i, run := range stored.Runs {
		views[i] = publicRun(run)
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": views, "count": len(views), "imported": stored.Imported, "updated": stored.Updated, "filesScanned": result.FilesScanned, "filesSkipped": result.FilesSkipped, "warnings": result.Warnings})
}

func (e *Store) listRuns(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 50
	if value := q.Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 100 {
			apiError(w, 400, "invalid limit")
			return
		}
		limit = parsed
	}
	filters, ok := parseRunFilters(w, r)
	if !ok {
		return
	}
	filters.limit = limit
	runs, next, total := e.list(filters)
	ids := make([]string, len(runs))
	for i, run := range runs {
		ids[i] = run.ID
	}
	snippets := e.Snippets(ids, filters.q)
	views := make([]RunView, len(runs))
	for i, run := range runs {
		views[i] = publicRun(run)
		views[i].Trace = nil
		views[i].Snippet = snippets[run.ID]
	}
	writeJSON(w, 200, map[string]any{"runs": views, "nextCursor": next, "total": total})
}

func parseFilterDate(value string, endOfDay bool) (time.Time, error) {
	if date, err := time.Parse("2006-01-02", value); err == nil {
		if endOfDay {
			return date.AddDate(0, 0, 1).Add(-time.Nanosecond), nil
		}
		return date, nil
	}
	return time.Parse(time.RFC3339, value)
}
func (e *Store) oneRun(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/session-insights/runs/")
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, run := range e.data.Runs {
		if run.ID != id {
			continue
		}
		if r.Method == http.MethodGet {
			view := publicRun(run.Run)
			trace, err := e.readTraceLocked(run.ID)
			if err != nil {
				apiError(w, http.StatusInternalServerError, "read local trace")
				return
			}
			view.Trace = trace
			if len(trace) == 0 {
				view.ParseWarnings = append(view.ParseWarnings, "trace_unavailable")
			}
			writeJSON(w, http.StatusOK, view)
			return
		}
		if r.Method == http.MethodDelete {
			for i := range e.data.Runs {
				if e.data.Runs[i].ID == id {
					e.data.Runs = append(e.data.Runs[:i], e.data.Runs[i+1:]...)
					break
				}
			}
			if err := e.persistLocked(); err != nil {
				apiError(w, http.StatusInternalServerError, "save local index")
				return
			}
			if err := os.RemoveAll(filepath.Dir(e.tracePath(id))); err != nil {
				apiError(w, http.StatusInternalServerError, "remove local trace")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	http.NotFound(w, r)
}

func (e *Store) deleteAll(w http.ResponseWriter) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.data.Runs = nil
	if err := e.persistLocked(); err != nil {
		apiError(w, http.StatusInternalServerError, "save local index")
		return
	}
	if err := os.RemoveAll(e.traceDir); err != nil {
		apiError(w, http.StatusInternalServerError, "remove local traces")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (e *Store) summary(w http.ResponseWriter) {
	e.mu.Lock()
	defer e.mu.Unlock()
	counts := map[string]int{}
	for _, run := range e.data.Runs {
		counts[run.Aggregate.Provider]++
	}
	writeJSON(w, 200, map[string]any{"runCount": len(e.data.Runs), "byProvider": counts})
}

var errLimit = errors.New("limit")

func copyLimit(dst io.Writer, src io.Reader, max int64) (int64, error) {
	if max < 0 {
		return 0, errLimit
	}
	n, err := io.Copy(dst, io.LimitReader(src, max+1))
	if err != nil {
		return n, err
	}
	if n > max {
		return n, errLimit
	}
	return n, nil
}
func detectProvider(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	claude := false
	for _, line := range strings.Split(string(b), "\n") {
		var record map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &record) != nil {
			continue
		}
		var recordType string
		_ = json.Unmarshal(record["type"], &recordType)
		if recordType == "session_meta" {
			var payload struct {
				ModelProvider string `json:"model_provider"`
			}
			_ = json.Unmarshal(record["payload"], &payload)
			switch strings.ToLower(strings.TrimSpace(payload.ModelProvider)) {
			case "trae", "traex":
				return "traex", nil
			default:
				return "codex", nil
			}
		}
		if _, ok := record["sessionId"]; ok {
			claude = true
		}
	}
	if claude {
		return "claude", nil
	}
	return "", errors.New("unknown provider")
}
