package sessionstore

import (
	"strings"
	"unicode/utf8"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

const (
	maxTitleRunes    = 120
	maxSearchTextLen = 2 << 10
	// Only the opening prompts are scanned for a title. A session's intent is
	// stated up front; later turns are follow-ups that read poorly as labels.
	titleScanEvents = 4
	// Context shown on each side of a search hit.
	snippetContextRunes = 42
)

// deriveDigest lifts a human-readable label and a content-search haystack out of
// a run's trace. Both are index-layer concerns: the parser's Aggregate stays free
// of transcript text, and the trace file remains the only place full excerpts live.
func deriveDigest(trace []sessioninsight.TraceEvent) (title, searchText string) {
	var prompts, replies []string
	scanned := 0
	for _, event := range trace {
		switch {
		case event.Type == "user":
			text := strings.TrimSpace(event.Input)
			if text == "" {
				continue
			}
			if title == "" && scanned < titleScanEvents {
				title = titleFromPrompt(text)
				scanned++
			}
			prompts = append(prompts, text)
		case event.Type == "model" && event.Name == "Agent response":
			if text := strings.TrimSpace(event.Output); text != "" {
				replies = append(replies, text)
			}
		}
	}
	// Prompts come first: a user searching their own history recalls what they
	// asked far more often than what the agent answered.
	return title, joinBounded(append(prompts, replies...), maxSearchTextLen)
}

// titleFromPrompt picks the first line that reads like a human instruction.
// Structural wrappers (teammate envelopes, slash-command markers) are unwrapped
// when they carry a summary and skipped otherwise.
func titleFromPrompt(input string) string {
	fallback := ""
	for _, raw := range strings.Split(input, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "<") {
			if summary := tagAttr(line, "summary"); summary != "" {
				return clipRunes(summary, maxTitleRunes)
			}
			if fallback == "" {
				if inner := tagInnerText(line); inner != "" {
					fallback = inner
				}
			}
			continue
		}
		line = strings.TrimSpace(strings.TrimLeft(line, "#>-* \t"))
		if line == "" {
			continue
		}
		return clipRunes(collapseSpaces(line), maxTitleRunes)
	}
	if fallback == "" {
		return ""
	}
	return clipRunes(collapseSpaces(fallback), maxTitleRunes)
}

// tagAttr reads one double-quoted attribute off an opening tag, e.g. the
// summary= on a <teammate-message> envelope.
func tagAttr(line, name string) string {
	needle := name + `="`
	start := strings.Index(line, needle)
	if start < 0 {
		return ""
	}
	rest := line[start+len(needle):]
	end := strings.Index(rest, `"`)
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(rest[:end])
}

// tagInnerText returns the text between an opening and closing tag on one line,
// e.g. "/model" out of <command-name>/model</command-name>.
func tagInnerText(line string) string {
	open := strings.Index(line, ">")
	if open < 0 || open+1 >= len(line) {
		return ""
	}
	rest := line[open+1:]
	close := strings.Index(rest, "<")
	if close < 0 {
		return strings.TrimSpace(rest)
	}
	return strings.TrimSpace(rest[:close])
}

// snippetAround returns the matched phrase with a little surrounding context, so
// a result whose title does not contain the query still explains why it matched.
func snippetAround(haystack, query string, context int) string {
	if haystack == "" || query == "" {
		return ""
	}
	at := strings.Index(strings.ToLower(haystack), strings.ToLower(query))
	if at < 0 {
		return ""
	}
	runes := []rune(haystack)
	// Convert the byte offset to a rune offset.
	start := len([]rune(haystack[:at]))
	end := start + len([]rune(query))
	from := start - context
	if from < 0 {
		from = 0
	}
	to := end + context
	if to > len(runes) {
		to = len(runes)
	}
	out := collapseSpaces(string(runes[from:to]))
	if from > 0 {
		out = "…" + out
	}
	if to < len(runes) {
		out += "…"
	}
	return out
}

func collapseSpaces(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func clipRunes(value string, limit int) string {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	count := 0
	for i := range value {
		if count == limit {
			return strings.TrimSpace(value[:i]) + "…"
		}
		count++
	}
	return value
}

func joinBounded(parts []string, limit int) string {
	var b strings.Builder
	for _, part := range parts {
		if b.Len() >= limit {
			break
		}
		part = collapseSpaces(part)
		if part == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		remaining := limit - b.Len()
		if len(part) > remaining {
			cut := remaining
			for cut > 0 && !utf8.RuneStart(part[cut]) {
				cut--
			}
			b.WriteString(part[:cut])
			break
		}
		b.WriteString(part)
	}
	return b.String()
}
