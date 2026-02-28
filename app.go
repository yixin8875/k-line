package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	goRuntime "runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/getlantern/systray"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var (
	// Version is injected by build flags in release workflow, e.g. -X main.Version=v1.2.3.
	Version = "dev"
	// Repo is injected by build flags in release workflow, e.g. -X main.Repo=owner/repo.
	Repo = ""
)

// App contains backend runtime state.
type App struct {
	mu          sync.Mutex
	ctx         context.Context
	allowQuit   bool
	alwaysOnTop bool

	trayIcon []byte
	trayOnce sync.Once
	trayQuit bool
	trayPin  *systray.MenuItem

	windowStatePath   string
	windowWatchCancel context.CancelFunc
	lastWindowW       int
	lastWindowH       int
}

type windowState struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type githubReleasePayload struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	HTMLURL     string `json:"html_url"`
	Body        string `json:"body"`
	PublishedAt string `json:"published_at"`
}

type UpdateInfo struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	HasUpdate      bool   `json:"hasUpdate"`
	ReleaseName    string `json:"releaseName"`
	ReleaseURL     string `json:"releaseURL"`
	PublishedAt    string `json:"publishedAt"`
	Notes          string `json:"notes"`
}

// NewApp creates a new App application struct.
func NewApp() *App {
	return &App{}
}

// SetTrayIcon injects tray icon bytes.
func (a *App) SetTrayIcon(icon []byte) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.trayIcon = icon
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	a.ctx = ctx
	a.mu.Unlock()

	a.initWindowStatePath()
	a.restoreWindowSize()
	a.startWindowSizeWatch()
	a.startTray()
}

// shutdown is called when the app exits.
func (a *App) shutdown(_ context.Context) {
	a.stopWindowSizeWatch()
	a.persistCurrentWindowSize()

	a.mu.Lock()
	started := a.trayPin != nil
	a.mu.Unlock()
	if started {
		systray.Quit()
	}
}

func (a *App) startTray() {
	a.mu.Lock()
	iconReady := len(a.trayIcon) > 0
	a.mu.Unlock()
	if !iconReady {
		return
	}

	a.trayOnce.Do(func() {
		go systray.Run(a.onTrayReady, a.onTrayExit)
	})
}

func (a *App) onTrayReady() {
	a.mu.Lock()
	icon := a.trayIcon
	onTop := a.alwaysOnTop
	a.mu.Unlock()

	systray.SetIcon(icon)
	systray.SetTitle("K-Line")
	systray.SetTooltip("K-Line Countdown Sentinel")

	showItem := systray.AddMenuItem("显示主窗口", "恢复并显示主窗口")
	pinItem := systray.AddMenuItemCheckbox("窗口置顶", "窗口保持最前", onTop)
	systray.AddSeparator()
	quitItem := systray.AddMenuItem("退出应用", "彻底退出提醒程序")

	a.mu.Lock()
	a.trayPin = pinItem
	a.mu.Unlock()

	go func() {
		for {
			select {
			case <-showItem.ClickedCh:
				a.RevealWindow()
			case <-pinItem.ClickedCh:
				a.SetAlwaysOnTop(!a.getAlwaysOnTop())
			case <-quitItem.ClickedCh:
				a.RequestQuit()
				return
			}
		}
	}()
}

func (a *App) onTrayExit() {
	a.mu.Lock()
	a.trayQuit = true
	a.mu.Unlock()
}

func (a *App) initWindowStatePath() {
	configDir, err := os.UserConfigDir()
	if err != nil || configDir == "" {
		configDir = "."
	}

	dir := filepath.Join(configDir, "kline-desktop")
	_ = os.MkdirAll(dir, 0o755)

	a.mu.Lock()
	a.windowStatePath = filepath.Join(dir, "window-state.json")
	a.mu.Unlock()
}

func (a *App) restoreWindowSize() {
	a.mu.Lock()
	ctx := a.ctx
	path := a.windowStatePath
	a.mu.Unlock()

	if ctx == nil || path == "" {
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	var state windowState
	if err = json.Unmarshal(data, &state); err != nil {
		return
	}

	if state.Width < 280 || state.Height < 380 || state.Width > 4000 || state.Height > 4000 {
		return
	}

	wailsRuntime.WindowSetSize(ctx, state.Width, state.Height)

	a.mu.Lock()
	a.lastWindowW = state.Width
	a.lastWindowH = state.Height
	a.mu.Unlock()
}

func (a *App) persistCurrentWindowSize() {
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx == nil {
		return
	}
	w, h := wailsRuntime.WindowGetSize(ctx)
	a.saveWindowSize(w, h)
}

func (a *App) saveWindowSize(w int, h int) {
	if w < 280 || h < 380 || w > 4000 || h > 4000 {
		return
	}

	a.mu.Lock()
	path := a.windowStatePath
	if path == "" {
		a.mu.Unlock()
		return
	}
	if a.lastWindowW == w && a.lastWindowH == h {
		a.mu.Unlock()
		return
	}
	a.lastWindowW = w
	a.lastWindowH = h
	a.mu.Unlock()

	content, err := json.Marshal(windowState{Width: w, Height: h})
	if err != nil {
		return
	}
	_ = os.WriteFile(path, content, 0o644)
}

func (a *App) startWindowSizeWatch() {
	a.mu.Lock()
	if a.ctx == nil || a.windowWatchCancel != nil {
		a.mu.Unlock()
		return
	}
	ctx := a.ctx
	watchCtx, cancel := context.WithCancel(context.Background())
	a.windowWatchCancel = cancel
	a.mu.Unlock()

	go func() {
		ticker := time.NewTicker(1200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-ticker.C:
				w, h := wailsRuntime.WindowGetSize(ctx)
				a.saveWindowSize(w, h)
			}
		}
	}()
}

func (a *App) stopWindowSizeWatch() {
	a.mu.Lock()
	cancel := a.windowWatchCancel
	a.windowWatchCancel = nil
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (a *App) getAlwaysOnTop() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.alwaysOnTop
}

// beforeClose intercepts window closing and keeps app running in background unless explicitly quitting.
func (a *App) beforeClose(ctx context.Context) bool {
	a.mu.Lock()
	allowQuit := a.allowQuit
	a.mu.Unlock()

	if allowQuit {
		return false
	}

	wailsRuntime.WindowHide(ctx)
	wailsRuntime.EventsEmit(ctx, "app:hidden-to-background")
	return true
}

// RequestQuit exits the app intentionally.
func (a *App) RequestQuit() {
	a.mu.Lock()
	ctx := a.ctx
	a.allowQuit = true
	trayQuit := a.trayQuit
	a.mu.Unlock()

	if !trayQuit {
		systray.Quit()
	}
	if ctx != nil {
		wailsRuntime.Quit(ctx)
	}
}

// RevealWindow shows the app window from background.
func (a *App) RevealWindow() {
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx == nil {
		return
	}
	wailsRuntime.WindowShow(ctx)
	wailsRuntime.WindowUnminimise(ctx)
}

// SetAlwaysOnTop toggles window pin status.
func (a *App) SetAlwaysOnTop(enabled bool) bool {
	a.mu.Lock()
	a.alwaysOnTop = enabled
	ctx := a.ctx
	pinItem := a.trayPin
	a.mu.Unlock()

	if ctx != nil {
		wailsRuntime.WindowSetAlwaysOnTop(ctx, enabled)
	}
	if pinItem != nil {
		if enabled {
			pinItem.Check()
		} else {
			pinItem.Uncheck()
		}
	}
	return enabled
}

// SetViewMode adjusts window size for different views.
func (a *App) SetViewMode(view string) {
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx == nil {
		return
	}

	switch view {
	case "journal":
		wailsRuntime.WindowSetSize(ctx, 760, 900)
	default:
		wailsRuntime.WindowSetSize(ctx, 430, 860)
	}
}

// NotifySystem sends an OS-level notification (macOS native currently).
func (a *App) NotifySystem(title string, subtitle string, message string) error {
	if message == "" {
		return errors.New("message is required")
	}
	if title == "" {
		title = "K-Line Reminder"
	}

	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()

	switch goRuntime.GOOS {
	case "darwin":
		return showMacNotification(title, subtitle, message)
	default:
		if ctx != nil {
			wailsRuntime.LogInfof(ctx, "NotifySystem fallback [%s]: %s", title, message)
		}
		return nil
	}
}

// PushExternalNotification sends alert messages to webhook/Telegram/WeCom channels.
func (a *App) PushExternalNotification(provider string, endpoint string, token string, chatID string, title string, message string) error {
	if strings.TrimSpace(message) == "" {
		return errors.New("message is required")
	}
	if strings.TrimSpace(title) == "" {
		title = "K-Line Reminder"
	}

	var (
		url  string
		body []byte
		err  error
	)

	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "webhook":
		if strings.TrimSpace(endpoint) == "" {
			return errors.New("webhook endpoint is required")
		}
		url = strings.TrimSpace(endpoint)
		body, err = json.Marshal(map[string]string{
			"title":   title,
			"message": message,
			"text":    title + "\n" + message,
		})
		if err != nil {
			return err
		}
	case "telegram":
		if strings.TrimSpace(token) == "" || strings.TrimSpace(chatID) == "" {
			return errors.New("telegram token and chatID are required")
		}
		url = "https://api.telegram.org/bot" + strings.TrimSpace(token) + "/sendMessage"
		body, err = json.Marshal(map[string]any{
			"chat_id":                  strings.TrimSpace(chatID),
			"text":                     title + "\n" + message,
			"disable_web_page_preview": true,
		})
		if err != nil {
			return err
		}
	case "wecom":
		if strings.TrimSpace(endpoint) == "" {
			return errors.New("wecom webhook url is required")
		}
		url = strings.TrimSpace(endpoint)
		body, err = json.Marshal(map[string]any{
			"msgtype": "text",
			"text": map[string]string{
				"content": title + "\n" + message,
			},
		})
		if err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported provider: %s", provider)
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		switch strings.ToLower(strings.TrimSpace(provider)) {
		case "telegram":
			var payload struct {
				OK          bool   `json:"ok"`
				Description string `json:"description"`
			}
			if len(responseBody) > 0 && json.Unmarshal(responseBody, &payload) == nil && !payload.OK {
				return fmt.Errorf("telegram push failed: %s", strings.TrimSpace(payload.Description))
			}
		case "wecom":
			var payload struct {
				ErrCode int    `json:"errcode"`
				ErrMsg  string `json:"errmsg"`
			}
			if len(responseBody) > 0 && json.Unmarshal(responseBody, &payload) == nil && payload.ErrCode != 0 {
				return fmt.Errorf("wecom push failed: %d %s", payload.ErrCode, strings.TrimSpace(payload.ErrMsg))
			}
		}
		return nil
	}

	return fmt.Errorf("push failed: status=%s body=%s", resp.Status, strings.TrimSpace(string(responseBody)))
}

func normalizeVersion(input string) string {
	trimmed := strings.TrimSpace(input)
	trimmed = strings.TrimPrefix(trimmed, "v")
	trimmed = strings.Split(trimmed, "-")[0]
	trimmed = strings.Split(trimmed, "+")[0]
	return trimmed
}

func parseSemver(input string) (int, int, int, bool) {
	normalized := normalizeVersion(input)
	parts := strings.Split(normalized, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, 0, 0, false
	}

	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, 0, false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, 0, false
	}

	patch := 0
	if len(parts) == 3 {
		patch, err = strconv.Atoi(parts[2])
		if err != nil {
			return 0, 0, 0, false
		}
	}

	return major, minor, patch, true
}

func isVersionNewer(latest string, current string) bool {
	la, lb, lc, lok := parseSemver(latest)
	ca, cb, cc, cok := parseSemver(current)
	if !lok || !cok {
		return false
	}
	if la != ca {
		return la > ca
	}
	if lb != cb {
		return lb > cb
	}
	return lc > cc
}

func shortNotes(input string, limit int) string {
	trimmed := strings.TrimSpace(input)
	if limit <= 0 || len(trimmed) <= limit {
		return trimmed
	}
	return strings.TrimSpace(trimmed[:limit]) + "..."
}

// CheckForUpdates checks latest GitHub release and returns update metadata.
func (a *App) CheckForUpdates() (UpdateInfo, error) {
	repo := strings.TrimSpace(Repo)
	if repo == "" {
		repo = strings.TrimSpace(os.Getenv("KLINE_GITHUB_REPO"))
	}
	if repo == "" {
		return UpdateInfo{}, errors.New("repo is empty, set via -X main.Repo=owner/repo")
	}

	apiURL := "https://api.github.com/repos/" + repo + "/releases/latest"
	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
	if err != nil {
		return UpdateInfo{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "kline-desktop-updater")

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return UpdateInfo{}, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return UpdateInfo{}, fmt.Errorf("github api failed: status=%s body=%s", resp.Status, strings.TrimSpace(string(body)))
	}

	var release githubReleasePayload
	if err = json.Unmarshal(body, &release); err != nil {
		return UpdateInfo{}, err
	}

	currentVersion := strings.TrimSpace(Version)
	if currentVersion == "" {
		currentVersion = "dev"
	}
	latestVersion := strings.TrimSpace(release.TagName)
	if latestVersion == "" {
		latestVersion = strings.TrimSpace(release.Name)
	}
	return UpdateInfo{
		CurrentVersion: currentVersion,
		LatestVersion:  latestVersion,
		HasUpdate:      isVersionNewer(latestVersion, currentVersion),
		ReleaseName:    release.Name,
		ReleaseURL:     release.HTMLURL,
		PublishedAt:    release.PublishedAt,
		Notes:          shortNotes(release.Body, 1800),
	}, nil
}

// OpenURL opens a URL in system browser.
func (a *App) OpenURL(target string) error {
	if strings.TrimSpace(target) == "" {
		return errors.New("url is required")
	}
	parsed, err := url.Parse(strings.TrimSpace(target))
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("unsupported url scheme")
	}

	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx == nil {
		return errors.New("runtime context unavailable")
	}
	wailsRuntime.BrowserOpenURL(ctx, parsed.String())
	return nil
}
