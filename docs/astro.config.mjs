import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { fileURLToPath } from 'node:url';

// https://astro.build/config
export default defineConfig({
  site: 'https://lumen-docs.example.com',
  base: '/',
  outDir: './dist',
  publicDir: './public',
  srcDir: './src',
  integrations: [
    starlight({
      title: 'Lumen Documentation',
      description:
        'Cohesive, searchable documentation for Lumen with live code examples and an embedded interactive playground.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      favicon: '/favicon.svg',
      social: {
        github: 'https://github.com/lumen/lumen',
      },
      editLink: {
        baseUrl: 'https://github.com/lumen/lumen/edit/main/docs/',
      },
      lastUpdated: true,
      pagination: true,
      // Search is enabled via the built-in Pagefind integration.
      pagefind: true,
      // Enable the table of contents and "on this page" navigation.
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
      // Custom CSS for the embedded interactive code playground.
      customCss: [
        './src/styles/custom.css',
        './src/styles/playground.css',
      ],
      // Register the embedded interactive code playground component
      // so it can be used across guides and API reference pages.
      components: {
        // Override the default footer to include the playground mount point.
        Footer: './src/components/Footer.astro',
        // Expose the playground as a reusable MDX component.
        // Usage in MDX: <CodePlayground example="basic-usage" />
        CodePlayground: './src/components/CodePlayground.astro',
      },
      // Sidebar / navigation configuration.
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'index' },
            { label: 'Contributing', slug: 'contributing' },
            { label: 'CI', slug: 'ci' },
            { label: 'Security', slug: 'security' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Overview', slug: 'guides' },
            { label: 'Guides Index', autogenerate: { directory: 'guides' } },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', slug: 'architecture' },
            { label: 'Architecture Index', autogenerate: { directory: 'architecture' } },
          ],
        },
        {
          label: 'Configuration',
          items: [
            { label: 'Policy Configuration', slug: 'policy-configuration' },
            { label: 'Production Key Management', slug: 'production-key-management' },
          ],
        },
        {
          label: 'Migration',
          items: [
            { label: 'Migration v1', slug: 'migration-v1' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: 'Overview', slug: 'api' },
            { label: 'API Reference (TypeDoc)', autogenerate: { directory: 'api' } },
          ],
        },
        {
          label: 'Playground',
          items: [
            { label: 'Interactive Playground', slug: 'playground' },
          ],
        },
      ],
      // Expressive Code powers the syntax highlighting and the
      // interactive code sandbox blocks embedded in the docs.
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        styleOverrides: {
          borderRadius: '0.5rem',
          codeFontSize: '0.9rem',
        },
      },
      head: [
        {
          tag: 'meta',
          attrs: {
            name: 'viewport',
            content: 'width=device-width, initial-scale=1',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'generator',
            content: 'Astro Starlight',
          },
        },
      ],
    }),
  ],
  vite: {
    resolve: {
      alias: {
        // Reuse the shared playground patterns from examples/playground.
        '@playground': fileURLToPath(new URL('../examples/playground', import.meta.url)),
        '@components': fileURLToPath(new URL('./src/components', import.meta.url)),
        '@styles': fileURLToPath(new URL('./src/styles', import.meta.url)),
      },
    },
    server: {
      fs: {
        // Allow Vite to serve files from the sibling examples/playground directory.
        allow: [
          fileURLToPath(new URL('..', import.meta.url)),
        ],
      },
    },
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      wrap: true,
    },
  },
});