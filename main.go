package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var trayIcon []byte

func main() {
	app := NewApp()
	app.SetTrayIcon(trayIcon)

	mainMenu := menu.NewMenu()
	mainMenu.Append(menu.AppMenu())
	controlMenu := mainMenu.AddSubmenu("控制")
	controlMenu.AddText("显示主窗口", nil, func(_ *menu.CallbackData) {
		app.RevealWindow()
	})
	controlMenu.AddSeparator()
	controlMenu.AddText("退出应用", nil, func(_ *menu.CallbackData) {
		app.RequestQuit()
	})

	err := wails.Run(&options.App{
		Title:             "K-Line Countdown Sentinel",
		Width:             430,
		Height:            860,
		HideWindowOnClose: true,
		Menu:              mainMenu,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		OnBeforeClose:    app.beforeClose,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
