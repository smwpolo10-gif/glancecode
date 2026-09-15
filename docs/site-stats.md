# Site stats on the G2 dashboard (optional)

Even Hub apps can't add dashboard widgets, but the dashboard's Calendar widget
shows events from your phone's calendar. The hub can publish today's Plausible
numbers as a subscribed calendar, with one all-day event per product, titled like
`Shop 120 visits · 4 App Store · 2 Play`. It refreshes every 10 minutes; your phone
decides how often it downloads the calendar.

## Set up

1. Create a Stats API key in Plausible (Settings, API Keys, Stats API).
2. Save it: `glancecode stats key` (input is hidden; stored with mode 600).
3. Add products to `~/.config/glancecode/config.json`:

```json
{
  "statsProducts": [
    {
      "label": "Shop",
      "site": "example.com",
      "visitors": { "goal": ["Homepage visited"] },
      "appStore": { "goal": ["App Store Badge Clicked", "app_store_clicked"] },
      "playStore": { "goal": ["Google Play Badge Clicked", "play_store_clicked"] }
    }
  ]
}
```

4. `glancecode service restart`, then `glancecode stats` to check the numbers.
5. `glancecode stats url` prints a `webcal://` link. On the iPhone add it under
   Settings, Apps, Calendar, Calendar Accounts, Add Account, Other, Add Subscribed
   Calendar, and include it in the Even app's Calendar widget settings.

## Rules

- Every count is unique visitors for today.
- `goal` narrows to visitors who completed a Plausible goal. The Stats API matches
  goals by their **display name**, so list the display name first and the raw event
  name after it. The first one Plausible recognizes is used.
- `filters` adds Plausible filters, for example
  `[["contains", "event:props:url", ["apps.apple.com"]]]`.
- Leave `visitors` as `{}` to count all visitors to the site.
- The feed has its own read-only token (`statsToken`), because Apple stores
  subscribed calendar URLs.
- On iOS, set Fetch New Data to every 15 minutes for the fastest updates.
