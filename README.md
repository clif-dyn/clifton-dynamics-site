# Clifton Dynamics website

A single-page website for Clifton Dynamics Pty Ltd, published at https://cliftondynamics.com.

## Files and preview

- `concept.html`: the current design preview, including the contact form.
- `index.html`: the reviewed homepage served by GitHub Pages.
- `CNAME`: the intended GitHub Pages custom domain.
- `contact-handler/`: a separate Node.js service that verifies enquiries and sends them through Proton SMTP.
- `tests/`: local checks; no real emails are sent by these tests.

The website itself stays one self-contained HTML file with no build step. The contact handler is deployed separately; GitHub Pages cannot run server-side code.

Preview with `python3 -m http.server 8841`, then open `http://127.0.0.1:8841/concept.html?theme=light#contact`. Use `theme=dark` for the dark preview, or omit the parameter to follow the visitor's system setting.

## Contact service

The service runs separately from GitHub Pages. The live website connects to the A8 through `https://a8.taild9a1ec.ts.net/enquiry`. On 22 October 2026, a browser submission from the live custom domain passed the spam check, was accepted by Proton and was confirmed in the receiving inbox. The website itself is hosted by GitHub Pages.

Production allows only `https://cliftondynamics.com` and `https://www.cliftondynamics.com`. A local preview origin can be added temporarily for authorised testing, then removed. The form disables sending if its endpoint is cleared.

Flow: website → HTTPS connection → contact service → Proton SMTP → the configured inbox.

The page bundles the MIT-licensed ALTCHA widget inline. The service generates and verifies short-lived proof-of-work challenges without a CAPTCHA provider account. This raises the cost of automated submissions; it is not a guarantee that a visitor is human. Honeypot and input validation, single-use challenges, persistent request limits and global sending limits provide additional protection. Challenges and rate-limit counters are kept in SQLite; enquiry content is not stored there or logged. Only the configured private recipient receives messages. Visitor email is used as Reply-To, with no automatic reply.

### Installation and isolation

The service requires Node.js 22.13 or newer with `node:sqlite`, plus Python 3 for the private mail-configuration helper. On a local build machine, run `npm ci` in `contact-handler/`, then run its tests. Transfer the tested handler, its dependencies and `deploy/` directory to the host. Run `sudo sh deploy/install.sh` from that release directory.

The installer creates a dedicated system account, root-owned code in `/opt/clifton-contact`, private configuration in `/etc/clifton-contact/credentials.env`, and private runtime state in `/var/lib/clifton-contact`. The systemd service starts at boot, restarts after failure, has restricted filesystem access and resource limits, and listens only on `127.0.0.1:8845`. The installer does not change router rules, firewall rules or DNS.

Check service status with `systemctl status clifton-contact` and local readiness with `curl http://127.0.0.1:8845/health`. `awaiting_mail_configuration` means credentials are absent; `ready` means they are present, not that inbox delivery has been proven. Stop the service with `sudo systemctl stop clifton-contact`.

### Mail and public connection

1. In Proton, open **Settings → All settings → IMAP/SMTP → SMTP tokens**. Generate a token for an active custom-domain address. Proton documents SMTP submission for paid Mail plans with custom-domain addresses. Use this dedicated SMTP token, never the Proton account password.
2. In an interactive terminal on the service host, run `sudo /opt/clifton-contact/configure-mail`. Enter the sender address, recipient and token there. The token entry is hidden. The helper saves root-only configuration and restarts the service. Do not paste credentials into chat or this repository.
3. Provide an HTTPS connection to the loopback service. The current deployment uses Tailscale Funnel, with permission scoped to the A8 alone and one HTTPS route pointing to `127.0.0.1:8845`. It needs no router port forwarding. Funnel remains a beta service with bandwidth limits. Both Tailscale and the contact service are enabled at boot.
4. Keep `ALLOWED_ORIGINS` restricted to the actual website origins. Leave `TRUST_LOCAL_PROXY=false` unless a reviewed local proxy reliably strips and overwrites `X-Real-IP`. With this default, visitors through a shared proxy share the conservative request/send limits. Do not trust arbitrary forwarded headers.
5. Set `CONTACT_CONFIG.endpoint` in the HTML only once the public service is ready. Keep all recipient addresses, SMTP tokens and the challenge secret on the server.

Before launch, test a real enquiry, confirm inbox delivery and Reply behaviour, and verify that missing, invalid, expired and reused challenge responses are rejected. Check widget loading, success, failure and retry states on desktop and phone in both themes. The host and its internet connection must remain available for submissions to work. Keep the OS, Node.js and dependencies updated; public access still requires ongoing maintenance despite service isolation.

### Funnel troubleshooting

`tailscale funnel status` alone does not prove public connectivity: private Tailscale access can work while public registration is missing. Check public DNS and HTTPS through a public relay, rather than the host's private Tailscale address. During setup, withdrawing and restoring the same narrowly scoped `funnel` node attribute caused the missing public DNS records to appear. Preserve the complete existing policy and verify both saves; do not replace the rule with an all-members permission. This workaround is discussed in [Tailscale issue 11849](https://github.com/tailscale/tailscale/issues/11849).

The current route can be stopped on the host with `sudo tailscale funnel --https=443 off`. To restore that route after checking its scope, use `sudo tailscale funnel --bg --https=443 http://127.0.0.1:8845`. Neither command changes the website's DNS records.

Run local checks:

```sh
node --test tests/contact-form.test.cjs
npm test --prefix contact-handler
npm run check --prefix contact-handler
```

Tests use synthetic submissions and mocked mail delivery; they do not send real emails. If a mounted workspace prevents dependency installation, copy the handler to a local filesystem, install dependencies there, and test that release before transfer.

## GitHub Pages and custom domain

The repository is `clif-dyn/clifton-dynamics-site`. GitHub Pages serves the root of `main`, with `cliftondynamics.com` as its custom domain. The `.nojekyll` file keeps publishing static with no site build step.

After approval and successful contact-service tests:

1. Promote the reviewed `concept.html` to `index.html` and recheck the homepage.
2. Connect the intended GitHub repository and publish the reviewed files. Never include private notes or credentials. Inspect the staged changes as well as the working files before committing.
3. Verify domain ownership in GitHub, enable Pages for the intended branch and folder, and set its custom domain to `cliftondynamics.com` **before** changing website DNS.
4. At the DNS provider, configure the website records below, after confirming the correct GitHub account. Namecheap manages the domain DNS; check the current records before making changes.
5. Once the certificate is issued, enable **Enforce HTTPS** and check apex and `www` redirects plus real form delivery.

| Type | Host | Value |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | clif-dyn.github.io |

Proton's MX and email-verification/SPF/DKIM/DMARC records stay intact. The form does not require changing mail delivery DNS.

## References

- [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Proton SMTP submission](https://proton.me/support/smtp-submission)
- [ALTCHA server integration](https://altcha.org/docs/integration/server/)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
