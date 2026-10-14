# Cargo Ops Suite

Create a personal app called Cargo Ops. This is a flight sim 2024 addon app that will connect with MS2024 and create a cargo company, prepare cargo operations etc. I need the basic build for Claude to work on. It will be beautiful UX/UI with gradient large text

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/3a3489ec-08c6-4fce-8123-bc5557636c10).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

The lockfile is `bun.lock`, so `bun install` gives the exact tested versions; npm resolves
the `package.json` ranges itself. Use Node.js 24 LTS (npm 11). On Node.js 22, whose
bundled npm 10 crashes on this dependency tree with
`Cannot read properties of null (reading 'edgesOut')`, install with
`npm i --legacy-peer-deps` (what `scripts\build-local.ps1` does automatically).

To run Cargo Ops on the Windows PC with the simulator, follow
[`docs/SETUP_WINDOWS.md`](docs/SETUP_WINDOWS.md); `scripts\start-cargo-ops.cmd` needs
Node.js 22.13 or newer (24 LTS recommended) and uses bun when it is installed.
