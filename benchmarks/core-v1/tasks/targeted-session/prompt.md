The authentication session expiry check is inverted. A session is valid when
its `expiresAt` timestamp is later than `now`; equality is expired. Fix this
without touching unrelated catalog, billing, notification, or search modules.
Keep the exported API and run the configured verification command.
