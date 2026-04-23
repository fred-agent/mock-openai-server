.DEFAULT_GOAL := help

DOCKER ?= docker
NPM ?= npm
HELM ?= helm
K3D ?= k3d
IMAGE ?= mock-openai-server:dev
REGISTRY ?=
IMAGE_FULL := $(if $(REGISTRY),$(REGISTRY)/,)$(IMAGE)
PORT ?= 8383
HELM_RELEASE ?= mock-openai-server
HELM_NAMESPACE ?= fred
HELM_CHART ?= deploy/helm/mock-openai-server
K3D_CLUSTER ?= fred

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

.PHONY: k3d-import
k3d-import: ## Import the image into the k3d cluster
	$(K3D) image import $(IMAGE_FULL) -c $(K3D_CLUSTER)

.PHONY: k3d-deploy
k3d-deploy: ## Deploy to the k3d cluster with Helm
	$(HELM) upgrade --install $(HELM_RELEASE) $(HELM_CHART) --namespace $(HELM_NAMESPACE) --create-namespace

.PHONY: k3d-all
k3d-all: docker-build k3d-import k3d-deploy ## Build, import, and deploy to the k3d cluster

##@ Clean

.PHONY: clean
clean: ## Remove node_modules
	rm -rf node_modules

##@ Help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\n"} /^[a-zA-Z0-9._-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)
