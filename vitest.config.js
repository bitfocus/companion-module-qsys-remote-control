import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['**/*.spec.js'],
		exclude: ['node_modules/**'],
		coverage: {
			provider: 'v8',
			// text for the CI log, lcov for Codecov, html for browsing locally
			reporter: ['text', 'lcov', 'html'],
			reportsDirectory: './coverage',
			include: ['*.js'],
			exclude: ['**/*.spec.js', 'vitest.config.js'],
		},
	},
})
