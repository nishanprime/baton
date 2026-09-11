import { execFile } from 'node:child_process';

/**
 * Desktop notification, best effort.
 *
 * Auto-switch is only useful if it reaches someone who is looking at an editor
 * rather than at Baton, so the message has to leave the app. Every platform
 * path here can fail — no notification daemon, a headless session, notifications
 * denied — and none of those should turn a successful switch into an error, so
 * nothing throws and nothing is awaited.
 */
export function notify(title: string, body: string): void {
  const done = (): void => {};

  try {
    if (process.platform === 'darwin') {
      // Single-quoted AppleScript strings: the text is interpolated, and a
      // title carrying a quote would otherwise end the string early.
      const esc = (s: string) => s.split('\\').join('\\\\').split('"').join('\\"');
      execFile(
        'osascript',
        ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`],
        done,
      );
      return;
    }

    if (process.platform === 'linux') {
      execFile('notify-send', [title, body], done);
      return;
    }

    if (process.platform === 'win32') {
      const ps = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
        '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1)',
        `$t.GetElementsByTagName('text')[0].AppendChild($t.CreateTextNode(${psLiteral(title)})) > $null`,
        `$t.GetElementsByTagName('text')[1].AppendChild($t.CreateTextNode(${psLiteral(body)})) > $null`,
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Baton').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], done);
    }
  } catch {
    /* a missing notifier is not a failure of the thing being reported */
  }
}

/** PowerShell single-quoted literal; the only escape inside is a doubled quote. */
function psLiteral(s: string): string {
  return `'${s.split("'").join("''")}'`;
}
