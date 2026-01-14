import Docker from "dockerode"
import {
  ContainerInfo,
  ContainerInspectInfo,
  Network,
  NetworkInfo,
  NetworkInspectInfo,
  NetworkContainer,
  NetworkCreateOptions
  } from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"

const DRAGONIFY_NETWORK_LABEL = "tj.horner.dragonify.networks"
const DRAGONIFY_NETWORK_NAME = "apps-internal"
const IX_DOCKER_LABEL = "com.docker.compose.project"
const ENV_CONNECT_ALL: string | undefined = process.env.CONNECT_ALL
const ENV_DEBUG: string | undefined = process.env.DEBUG
let TERMINATING: boolean = false

let CONNECT_ALL: boolean = true
if (ENV_CONNECT_ALL !== undefined && ENV_CONNECT_ALL == "false") {
  CONNECT_ALL = false
}

let DEBUG: boolean = false
if (ENV_DEBUG !== undefined && ENV_DEBUG == "true") {
  DEBUG = true
}

logger.info(`Dragonify starting...`)
logger.info(`DEBUG: ${DEBUG}`)
logger.info(`LOG_LEVEL: ${process.env.LOG_LEVEL || "info"}`)
logger.info(`CONNECT_ALL: ${CONNECT_ALL}`)
if (CONNECT_ALL) {
  logger.info(`DRAGONIFY_NETWORK_NAME: "${DRAGONIFY_NETWORK_NAME}"`)
}
logger.info(`DRAGONIFY_NETWORK_LABEL: "${DRAGONIFY_NETWORK_LABEL}"`)

type NetworkContainers = {
  [id: string]: NetworkContainer,
}

// We hold the Docker object instance globally to avoid having to pass it on every function call
const DOCKER: Docker = new Docker()

// During initialisation and shutdown we will be making frequent changes to existing networks,
// so we will hold the lost of DOCKER networks globally and only refresh them when we need to.
// This needs to be updated whenever we add or remove a network or add or remove a container from a network.
let dockerNetworks: Docker.NetworkInspectInfo[] = []

async function updateDockerNetworks(): Promise<void> {
  dockerNetworks = await DOCKER.listNetworks()
  logger.debug(
    `dockerNetworks ${dockerNetworks.length}`,
    Object.values(dockerNetworks.map((network: NetworkInspectInfo) => network.Name))
  )
}

function getDockerNetworkByName(networkName: string): NetworkInspectInfo | undefined {
  return dockerNetworks.find(nw => nw.Name === networkName)
}

function getDockerNetworkById(networkId: string): NetworkInspectInfo | undefined {
  return dockerNetworks.find(nw => nw.Id === networkId)
}

function isDockerNetworkNameExists(networkName: string): boolean {
  return getDockerNetworkByName(networkName) !== undefined
}

function replaceDockerNetwork(network: NetworkInspectInfo | undefined): void {
  if (network === undefined) {
    return
  }
  if (isDockerNetworkNameExists(network.Name)) {
    removeNetworkByIdFromDockerNetworks(network.Id)
    dockerNetworks.push(network)
    logger.debug(`replaceDockerNetwork: Replaced "${network}":`, dockerNetworks)
  } else {
    dockerNetworks.push(network)
    logger.debug(`replaceDockerNetwork: Added "${network}":`, dockerNetworks)
  }
}

function removeNetworkByIdFromDockerNetworks(networkId: string): void {
  dockerNetworks = dockerNetworks.filter((dockerNetwork) => {
    return dockerNetwork.Id !== networkId
  })
  logger.debug(`removeNetworkByIdFromDockerNetworks: Removed "${networkId}":`, dockerNetworks)
}

function removeNetworkByNameFromDockerNetworks(networkName: string): void {
  dockerNetworks = dockerNetworks.filter((dockerNetwork) => {
    return dockerNetwork.Name !== networkName
  })
  logger.debug(`removeNetworkByNameFromDockerNetworks: Removed "${networkName}":`, dockerNetworks)
}

// Similarly to save queries we need to keep track of the network's connected containers.
async function getDockerNetworkContainers(dockerNetwork: NetworkInspectInfo | undefined): Promise<NetworkContainers> {
  if (dockerNetwork === undefined) {
    return {}
  }

  let network: NetworkInspectInfo = dockerNetwork
  if (!DEBUG && !("Containers" in dockerNetwork)) {
    network = await DOCKER.getNetwork(dockerNetwork.Id).inspect()
    replaceDockerNetwork(network)
  }

  const containers: NetworkContainers | undefined = network.Containers
  logger.debug(`getDockerNetworkContainers: Containers in "${dockerNetwork.Name}":`, containers)
  return containers ?? {}
}

type Container = {
  Id: string,
  Name: string,
  Labels: { [label: string]: string },
  NetworkMode?: string,
  Networks: { [networkType: string]: NetworkInfo },
}

function ContainerFromContainerInfo(info: ContainerInfo): Container {
  const container: Container = {
    Id: info.Id,
    Name: info.Names.join(","),
    Labels: info.Labels,
    NetworkMode: info.HostConfig.NetworkMode,
    Networks: info.NetworkSettings.Networks,
  }
  return container
}

function ContainerFromContainerInspectInfo(info: ContainerInspectInfo): Container {
  const container: Container = {
    Id: info.Id,
    Name: info.Name,
    Labels: info.Config.Labels,
    NetworkMode: info.HostConfig.NetworkMode,
    Networks: info.NetworkSettings.Networks,
  }
  return container
}

function NetworkContainerFromContainer(container: Container, networkName: string): NetworkContainer {
  const networkContainer: NetworkContainer = {
    Name: container.Name,
    EndpointID: "",
    MacAddress: "",
    IPv4Address: "",
    IPv6Address: "",
  }
  if (networkName in container.Networks) {
    const network: NetworkInfo = container.Networks[networkName]
    networkContainer.EndpointID = network.EndpointID
    networkContainer.MacAddress = network.MacAddress
    networkContainer.IPv4Address = network.IPAddress + "/" + network.IPPrefixLen.toString()
    networkContainer.IPv6Address = network.GlobalIPv6Address + "/" + network.GlobalIPv6PrefixLen.toString()
  }
  return networkContainer
}

async function addContainerToNetwork(container: Container, networkName: string): Promise<void> {
  const network: NetworkInspectInfo | undefined = getDockerNetworkByName(networkName)
  if (network === undefined) {
    return
  }
  let containers: NetworkContainers | undefined = await getDockerNetworkContainers(network)
  if (containers === undefined) {
    containers = network.Containers = {}
  }

  containers[container.Id] = NetworkContainerFromContainer(container, networkName)
  logger.debug(`addContainerToNetwork: Container "${container.Name}" added to "${networkName}":`, containers)
}

async function removeContainerFromNetwork(container: Container, networkName: string): Promise<void> {
  const network: NetworkInspectInfo | undefined = getDockerNetworkByName(networkName)
  if (network === undefined) {
    return
  }
  const containers: NetworkContainers = await getDockerNetworkContainers(network)

  delete containers[container.Id]
  logger.debug(`removeContainerFromNetwork: Container "${container.Name} removed from "${networkName}":`, containers)

  // If we have removed the last connection from a network we created, then remove the network
  if (
    Object.entries(containers).length === 0 &&
    network.Labels !== undefined &&
    DRAGONIFY_NETWORK_LABEL in network.Labels &&
    network.Labels[DRAGONIFY_NETWORK_LABEL] === "true"
  ) {
    logger.info(`Removing Dragonify network "${networkName}" because it has no connected containers.`)
    removeNetwork(networkName)
  }
}

async function isDockerNetworkConnected(dockerNetwork: NetworkInspectInfo | undefined): Promise<boolean> {
  if (dockerNetwork === undefined) {
    return false
  }
  const containers: NetworkContainers = await getDockerNetworkContainers(dockerNetwork)
  return (dockerNetwork.Id in containers)
}

async function isNetworkNameConnected(networkName: string): Promise<boolean> {
  return await isDockerNetworkConnected(getDockerNetworkByName(networkName))
}

async function createNetwork(networkName: string, dragonifyNetwork: boolean): Promise<boolean> {
  if (await isDockerNetworkNameExists(networkName)) {
    logger.debug(`createNetwork: Network "${networkName}" already exists.`)
    return false
  }

  if (DEBUG) {
    let dockerNetwork: NetworkInspectInfo = {
      Name: networkName,
      Id: (Math.random() * 0xFFFFFFFFFFFFF).toString(16).slice(0, 8).repeat(8).toLowerCase(),
      Created: "",
      Scope: "",
      Driver: "",
      EnableIPv6: true,
      Internal: true,
      Attachable: true,
      Ingress: false,
      ConfigOnly: false
    }
    logger.debug("DEBUG: New network:", dockerNetwork)
    logger.info(`DEBUG network "${networkName}" created.`)
    replaceDockerNetwork(dockerNetwork)
    return true
  }

  const networkOptions: NetworkCreateOptions = {
    Name: networkName,
    Driver: "bridge",
    Internal: true,
    Labels: dragonifyNetwork ? { [DRAGONIFY_NETWORK_LABEL]: "true"} : {},
  }

  logger.debug(`createNetwork: Creating network with details:`, networkOptions)
  try {
    const network: Network = await DOCKER.createNetwork(networkOptions)
    const dockerNetwork: NetworkInspectInfo = await network.inspect()
    logger.debug("New network:", dockerNetwork)
    logger.info(`Network "${networkName}" created.`)
    replaceDockerNetwork(dockerNetwork)
  } catch (e: any) {
    if (e.statusCode !== 409) throw e
    // 409 error is caused by multiple containers using the same network starting simultaneously e.g. NextCloud.
    // Since the net result is that the network has been created this can be safely ignored.
    logger.warning(
      `createNetwork: Network "${networkName}" creation failed with 409 - ` +
      `likely duplicate parallel execution and other attempt succeeded - check the log`
    )
  }

  return true
}

async function removeNetwork(networkName: string): Promise<boolean> {
  const dockerNetwork = getDockerNetworkByName(networkName)
  if (dockerNetwork === undefined) {
    logger.warning(`removeNetwork: Network "${networkName}" does not exist.`)
    return false
  }

  if (await isDockerNetworkConnected(dockerNetwork)) {
    logger.warning(`removeNetwork: Network "${networkName}" is not empty.`)
    return false
  }

  if (DEBUG) {
    logger.debug("DEBUG: Remove network:", dockerNetwork.Id)
    logger.info(`DEBUG network "${dockerNetwork.Name}" removed.`)
    removeNetworkByIdFromDockerNetworks(dockerNetwork.Id)
    return true
  }

  await DOCKER.getNetwork(dockerNetwork.Id).remove()
  logger.info(`Network "${dockerNetwork.Name}" removed.`)
  removeNetworkByIdFromDockerNetworks(dockerNetwork.Id)

  return true
}

function getDnsNameFromContainer(container: Container): string {
  const service = container.Labels["com.DOCKER.compose.service"]
  const project = container.Labels[IX_DOCKER_LABEL]
  return `${service}.${project}.svc.cluster.local`
}

function isIxProjectName(name: string) {
  return name?.startsWith("ix-") ?? false
}

async function getIxContainers(): Promise<Container[]> {
  const containerInfos: ContainerInfo[] = await DOCKER.listContainers({
    limit: -1,
    filters: {
      label: [ IX_DOCKER_LABEL ]
    }
  })

  const containers: Container[] = containerInfos.map(ContainerFromContainerInfo)
  const filteredContainers: Container[] = containers.filter((container: Container) => {
    return isIxProjectName(container.Labels[IX_DOCKER_LABEL])
  })

  return filteredContainers
}

async function connectContainerToNetwork(container: Container, networkName: string): Promise<void> {
  await createNetwork(networkName, true)

  const dnsName = getDnsNameFromContainer(container)

  if (DEBUG) {
    logger.info(`DEBUG container "${container.Name}" connected to network "${networkName}".`)
    addContainerToNetwork(container, networkName)
    return
  }

  logger.debug(`Connecting container ${container.Name} to network "${networkName}" as ${dnsName}...`)
  try {
    await DOCKER.getNetwork(networkName).connect({
      Container: container.Id,
      EndpointConfig: {
        Aliases: [ dnsName ],
      }
    })
    logger.info(`Container ${container.Name} connected to network "${networkName}" as ${dnsName}`)
    addContainerToNetwork(container, networkName)
  } catch (e: any) {
    logger.error(`connectContainerToNetwork: Failed to connect container ${container.Id} to network "${networkName}":`, e)
  }
}

async function disconnectContainerFromNetwork(container: Container, networkName: string): Promise<void> {

  if (DEBUG) {
    logger.info(`DEBUG container "${container.Name}" disconnected from network "${networkName}".`)
    addContainerToNetwork(container, networkName)
    return
  }

  logger.debug(`Disconnecting container ${container.Name} from network "${networkName}"...`)
  try {
    await DOCKER.getNetwork(networkName).disconnect({Container: container.Id})
    logger.info(`Container "${container.Name}" disconnected from "${networkName}".`)
    removeContainerFromNetwork(container, networkName)
  } catch (e: any) {
    logger.error(`disconnectContainerFromNetwork: Failed to disconnect container ${container.Id} from network "${networkName}":`, e)
  }
}

function isContainerNetworkMoveable(networkMode: string | undefined): boolean {
  if (networkMode === undefined) {
    return false
  }
  return !(
    [ "none", "host" ].includes(networkMode) ||
    networkMode.startsWith("container:") ||
    networkMode.startsWith("service:")
  )
}

function getContainerNetworks(container: Container): string[] {
  return Object.keys(container.Networks)
}

async function moveContainerToNetworks(container: Container, targetNetworks: string[]): Promise<void> {
  if (!isContainerNetworkMoveable(container.NetworkMode)) {
    logger.warning(
      `Container "${container.Id}" unmoveable to "${targetNetworks.join(', ')}" ` +
      `because network mode is "${container.NetworkMode}".`
      )
    return
  }

  const existingNetworks: string[] = getContainerNetworks(container)

  // Connect to target networks if not already connected
  for (const targetNetwork of targetNetworks) {
    if (!existingNetworks.includes(targetNetwork)) {
      await connectContainerToNetwork(container, targetNetwork)
    }
  }

  // Disconnect from existing networks if not in targets
  for (const existingNetwork of existingNetworks) {
    if (!targetNetworks.includes(existingNetwork)) {
      await disconnectContainerFromNetwork(container, existingNetwork)
    }
  }
}

async function resetContainerNetworks(container: Container) {
  const containerDefaultNetwork: string = container.Labels["com.docker.compose.project"] + "_default"
  await moveContainerToNetworks(container, [containerDefaultNetwork])
}

function containerNetworksToMoveTo(networkLabel: string): string[] {
  return networkLabel.split(",") ?? [DRAGONIFY_NETWORK_NAME]
}

async function getContainerById(containerId: string): Promise<Container> {
  return ContainerFromContainerInspectInfo(await DOCKER.getContainer(containerId).inspect())
}

async function containerStarting(containerID: string) {
  await updateDockerNetworks()

  const container: Container = await getContainerById(containerID)
  if (CONNECT_ALL) {
    logger.debug(`connecting all: "${container.Name}..."`)
    await moveContainerToNetworks(container, [DRAGONIFY_NETWORK_NAME])
  }
  else if (DRAGONIFY_NETWORK_LABEL in container.Labels) {
    logger.debug(`connecting specific: "${container.Name}..."`)
    const networks: string[] = containerNetworksToMoveTo(container.Labels[DRAGONIFY_NETWORK_LABEL])
    await moveContainerToNetworks(container, networks)
  }
  else {
    logger.debug(`not connecting: "${container.Name}"`)
  }
}

// Connect dragonified container to ix default app network regardless of CONNECT_ALL
async function containerStopping(containerID: string) {
  const container: Container = await getContainerById(containerID)

  if (!CONNECT_ALL && !(DRAGONIFY_NETWORK_LABEL in container.Labels)) {
    logger.debug(`not disconnecting: "${container.Name}"`)
    return // not dragonified
  }

  logger.debug(`disconnecting: "${container.Name}"...`)
  await resetContainerNetworks(container)
}

async function initialiseDragonify(): Promise<void> {
  const containers = await getIxContainers()

  let n: number = 0

  await containers.forEach((container) => {
    if (CONNECT_ALL) {
      logger.debug(`initialising all: "${container.Name}"`)
      moveContainerToNetworks(container,[DRAGONIFY_NETWORK_NAME])
      n++
    }
    else if (DRAGONIFY_NETWORK_LABEL in container.Labels) {
      logger.debug(`initialising specific: "${container.Name}"`)
      const networks: string[] = containerNetworksToMoveTo(container.Labels[DRAGONIFY_NETWORK_LABEL])
      moveContainerToNetworks(container, networks)
      n++
    }
    else {
      logger.debug(`not initialising: "${container.Name}"`)
    }
  })

  logger.info(`${n} containers initialised.`)
}

async function terminateDragonify() {
  const containers: Container[] = await getIxContainers()

  let n: number = 0

  await containers.forEach((container: Container) => {
    if (!CONNECT_ALL && !(DRAGONIFY_NETWORK_LABEL in container.Labels)) {
      logger.debug(`not terminating: "${container.Name}"`)
      return // not dragonified
    }
    logger.debug(`terminating: "${container.Name}"`)
    resetContainerNetworks(container)
    n++
  })

  logger.info(`${n} containers terminated.`)
}

async function main() {
  await updateDockerNetworks()

  try {
    logger.info(`Dragonify initialising...`)
    await initialiseDragonify()
    logger.info(`Dragonify initialised.`)
  } catch (e: any) {
    logger.error(`Exception during initialiseDragonify:`, e)
  }

  process.on('SIGTERM', (...args) => {
    logger.info("SIGTERM received, dragonify stopping", ...args)
    TERMINATING = true // prevent containers starting being processed
    try {
      logger.info("Dragonify terminating...");
      terminateDragonify()
      logger.info("Dragonify closed.");
    } catch (e: any) {
      logger.error(`Exception during terminateDragonify:`, e)
    }
    setTimeout(process.exit, 5000, 123);
  });

  const events = getEventStream(DOCKER)
  events.on("container.start", (dockerEvent) => {
    const containerAttributes = dockerEvent.Attributes
    if (!isIxProjectName(containerAttributes[IX_DOCKER_LABEL])) {
      return
    }

    if (TERMINATING) {
      logger.info(`Terminating: Container start ignored: "${containerAttributes.Name}"...`)
      return
    }

    logger.info(`App container starting: "${containerAttributes.name}"...`)
    try {
      containerStarting(dockerEvent.ID)
    } catch (e: any) {
      logger.error(`Exception during containerStarting:`, e)
    }
  })

  events.on("container.stop", (dockerEvent) => {
    const containerAttributes = dockerEvent.Attributes
    if (!isIxProjectName(containerAttributes[IX_DOCKER_LABEL])) {
      return
    }

    logger.info(`App container stopping: "${containerAttributes.name}"...`)
    try {
      containerStopping(dockerEvent.ID)
    } catch (e: any) {
      logger.error(`Exception during containerStopping:`, e)
    }
  })
}

main()

// To do
// Allow types of new network to be specified in labels
// Allow container:container name to be specified in labels
// If container2 has network container:container1, then:
// * not only do we attach container2 to container:container1 when it starts; but
// * if container2 is already running and we start container1 then we need to attach it
// * if both containers are running and container1 stops, we should move container2 back to its native network.
// Improve DNS definitions
// Prioritise routing for each app connected to multiple networks (i.e. based on sequence specified in label)
// Warn if network type wanted is NOT same as actual network type.