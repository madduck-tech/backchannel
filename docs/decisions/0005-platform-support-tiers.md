# ADR 0005: Уровни поддержки платформ и среда разработки

Дата: 2026-09-01
Статус: принято

## Контекст

Спека требует Windows/macOS/Linux (§45) и overlay с always-on-top, хоткеями и share protection (§9).
Разработка ведётся на одной машине: Ubuntu, GNOME 46, Wayland, PipeWire 1.0.5. Mac недоступен.

Факты (2026-09-01):

- **macOS.** Дефолтный бэкенд системного звука в форке — Core Audio process tap (разрешение «Audio capture»,
  macOS 14.4+), ScreenCaptureKit — фолбэк. Overlay, always-on-top, content protection, глобальные хоткеи — штатно в Tauri.
- **Windows.** WASAPI loopback через cpal в форке. Content protection в Tauri работает только вызовом в рантайме
  после создания окна, флаг конфига там не действует.
- **Linux.**
  - Системный звук в форке ищет ALSA-устройства со словом `monitor` через cpal; на PipeWire-системах таких нет
    (проверено: ALSA отдаёт только `pipewire`, `default`, железо). Путь фактически не работает.
  - Always-on-top: tao — «Wayland: Unsupported»; GNOME не реализует layer-shell.
  - Content protection: не поддерживается.
  - Глобальные хоткеи: crate `global-hotkey` — только X11; портал GlobalShortcuts в GNOME 46 отсутствует.
  - В сессии «Ubuntu on Xorg» always-on-top и хоткеи работают, share protection — нет.

## Решение

1. **Уровни поддержки.** macOS и Windows — полный overlay. Linux — полный звук и копилот; overlay обычным окном
   на Wayland, хоткеи и always-on-top только в X11-сессии, share protection отсутствует.
   Так и пишем в README; Мастер настройки определяет тип сессии и сообщает об этом сразу.
2. **Milestone 0, п. 1** получает подпункт: системный звук на Linux через PulseAudio-протокол
   (`libpulse-binding` через pipewire-pulse / PulseAudio, открываем `<sink>.monitor`).
   Нативный `pipewire` crate — альтернатива, если libpulse окажется недостаточно. Без этого Linux не проходит Milestone 0.
3. **macOS:** оставляем Core Audio tap по умолчанию с фолбэком на ScreenCaptureKit.
4. **Windows:** content protection включается в рантайме.
5. **Среда разработки — только эта Linux-машина.** Следствия:
   - Milestone 0 проходится сначала на Linux; overlay разрабатывается в Xorg-сессии.
   - macOS и Windows в Milestone 0 проверяются только сборкой в CI. Ручная проверка звука и overlay на них
     откладывается до появления доступа к машинам (виртуалка для Windows, чужой Mac или CI с самостоятельным
     smoke-тестом позже).
   - Платформо-специфичный код для macOS/Windows пишется вслепую и помечается как непроверенный.
