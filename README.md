# lpc-web-flash

Browser-based Web Serial flasher for NXP LPC175x/176x. Supports BIN and Intel HEX,
full backups, sector preservation, and readback verification. Firmware stays in
your browser.

- warning: use at your own risk -

## Use

Open [the flasher](https://fnoelscher.github.io/lpc-web-flash/) in desktop Chrome or Edge. Choose a serial port,
enter ROM ISP using your board's buttons, then click **ISP mode entered — continue**.
Repeat the manual boot step for every new session.

Default baud rate is **230400**. Set the crystal frequency to your board's value
(default: 12000 kHz). Back up the device, load an image, review the flash plan,
then flash and verify. BIN supports an offset; HEX uses absolute addresses.
Vector-checksum repair is optional. Under **Code read protection & chip erase**,
select Disabled, CRP1 or CRP2, then review and confirm the change. This can also
override the protection word in a firmware image. CRP3 and ISP-disable patterns
are blocked by default; CRP3 cannot be recovered with ROM ISP chip erase.
**Chip erase permanently deletes all flash** and removes CRP1/2 after a power
cycle. Re-enter ISP manually before programming. Keep power connected during writes.

## Development

Requires Node.js 24, Python 3, `arm-none-eabi-gcc`, and `arm-none-eabi-objcopy`.

```sh
nvm use
npm ci
npm run build
npm test
npx playwright install chromium
npm run e2e
npm run dev
```

Development URL: `http://127.0.0.1:5173/lpc-web-flash/`.
Browser tests use a simulated device; hardware testing remains separate.

## Repository and deployment

Never commit firmware, backups, captures, or generated binaries. Never create tags.
Use short commit messages. `npm ci` installs firmware checks for commits and pushes;
CI also checks source and Git history. Keep device files outside the repository.

For GitHub Pages, select **GitHub Actions** in **Settings → Pages**. The workflow
tests and deploys `main` to `https://fnoelscher.github.io/lpc-web-flash/`.

[MIT licensed](LICENSE).
