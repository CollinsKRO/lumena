# Builds every Soroban contract in the workspace and shrinks the resulting
# WASM binaries with wasm-opt. Run from the repository root with
# `make -C contracts` or from this directory with `make`.

WASM_TARGET  ?= wasm32-unknown-unknown
WASM_OPT     ?= wasm-opt
WASM_OPT_FLAGS ?= -Oz --strip-debug

ROOT_DIR     := $(abspath ..)
RELEASE_DIR  := $(ROOT_DIR)/target/$(WASM_TARGET)/release
OPTIMIZED_DIR := $(ROOT_DIR)/target/optimized

.PHONY: all build optimize test clean

all: optimize

build:
	cargo build --manifest-path $(ROOT_DIR)/Cargo.toml --target $(WASM_TARGET) --release

optimize: build
	@mkdir -p $(OPTIMIZED_DIR)
	@set -e; for wasm in $(RELEASE_DIR)/*.wasm; do \
		name=$$(basename $$wasm); \
		$(WASM_OPT) $(WASM_OPT_FLAGS) $$wasm -o $(OPTIMIZED_DIR)/$$name; \
		before=$$(wc -c < $$wasm); \
		after=$$(wc -c < $(OPTIMIZED_DIR)/$$name); \
		echo "$$name: $$before -> $$after bytes ($$(( (before - after) * 100 / before ))% smaller)"; \
	done

test:
	cargo test --manifest-path $(ROOT_DIR)/Cargo.toml

clean:
	cargo clean --manifest-path $(ROOT_DIR)/Cargo.toml
