.DEFAULT_GOAL := help

DOCKER ?= docker
NPM ?= npm
IMAGE ?= mock-openai-server:dev
REGISTRY ?=
IMAGE_FULL := $(if $(REGISTRY),$(REGISTRY)/,)$(IMAGE)
PORT ?= 8383

##@ App

.PHONY: install
install: ## Install production deps (same as image)
	$(NPM) ci --omit=dev

.PHONY: dev
dev: ## Start the mock server locally (uses config.yaml)
	$(NPM) run server

##@ Container

.PHONY: docker-build
docker-build: ## Build the mock server image
	$(DOCKER) build -t $(IMAGE_FULL) .

.PHONY: docker-run
docker-run: docker-build ## Run the image locally exposing PORT
	$(DOCKER) run --rm -p $(PORT):$(PORT) -e PORT=$(PORT) $(IMAGE_FULL)

.PHONY: docker-smoke
docker-smoke: docker-build ## Hit /health once inside the container
	$(DOCKER) run --rm -p $(PORT):$(PORT) -e PORT=$(PORT) $(IMAGE_FULL) sh -c "wget -qO- http://localhost:$$PORT/health"

##@ Clean

.PHONY: clean
clean: ## Remove node_modules
	rm -rf node_modules

##@ Help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\n"} /^[a-zA-Z0-9._-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)
