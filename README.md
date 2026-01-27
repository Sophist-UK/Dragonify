<script type="module"> import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'; mermaid.initialize({securityLevel: 'loose',});</script>
# Dragonify

***Dragonify*** is a small docker-container based utility app for TrueNAS Scale 24.10 (Electric Eel) onwards
which can reconfigure the default Docker networks provided by TrueNAS Scale for apps to allow them to communicate
with each other.

## Short Explanation

In Dragonfish and earlier (which used Kubernetes)
all apps were on the default shared network,
but from Electric Eel onwards
TrueNAS creates a separate virtualised docker network for each TrueNAS app
(presumably for security reasons)
and this makes it difficult or impossible for different apps to communicate with one another.

Dragonify provides a solution to this problem by allowing you
to move apps onto one or more shared networks.

### Caution

1. This approach of changing networks is uses official documented Docker API calls,
but is unsupported by TrueNAS.
This app is independently produced open-source software, and is unsupported by TrueNAS.

2. This app changes the network configuration of a container
**after** it has initialised.
Some apps are not capable of recognising such network changes
or are not capable of reconfiguring themselves to use the new network.
For these apps, you may need to attach the other containers to either:

   a. the existing docker network for the app; or
   b. the app container.

   Some experimentation and trial and error
   may be needed to make shared networking work
   for your specific combination of apps.

3. This uses the docker socket to make Docker API calls
to allow Dragonify to change networks,
and this comes with some risks.
We have done what we can to mitigate any security risks
(see [Security Hardening](#Security-Hardening) below)
however you should ensure that you
are comfortable with accepting any remaining security risks.

   **Note:** This is also true of other Docker management platforms
   that use the Docker API through the Docker API socket
   such as Portainer or Dockge -
   we are simply being up-front about it.

## Status

***THIS IS A WORK-IN-PROGRESS VERSION OF THE README DESCRIBING A TO-BE VERSION OF DRAGONIFY - WITH THE PURPOSE OF GIVING A VISION AND INVITING INPUT ABOUT THE VISION AND TECHNICAL DETAILS OF IMPLEMENTING IT. YOUR INPUT IS REQUESTED PARTICULARLY:***

* ***WHAT ARCHITECTURES SHOULD BE ADOPTED?***
* ***HOW SHOULD THE USER CONFIGURE THEM?***
* ***HOW DO WE GET CONTAINERS TO RECOGNISE NETWORK ATTACHMENTS/DETACHMENTS?***
* ***HOW CAN WE MINIMISE IMPACTS OF NETWORK ATTACH/DETACH?***
* ***HOW DO WE SET HOST NAMES AND MAKE SURE DNS WORKS?***

***PLEASE PROVIDE YOUR FEEDBACK TO [SOPHIST@SODALIS.CO.UK](mailto:sophist@sodalis.co.uk).***

## TrueNAS standard Docker networking

In its initial form in TrueNAS Scale Electric Eel, the application networking differs substantially from the previous Kubernetes networking architecture (where all apps shared a single container network and could communicate with one another).

iX's initial Docker-apps implementation has only two options for Docker networks:

1. Default - every app is connected to its own app-specific Docker bridged network with its own private subnet (by default in the 172.*.*.* range). This means that apps cannot communicate with other apps except through published ports.

   *Note:* Complex apps that have multiple containers (e.g. NextCloud) will have all these containers in a single network and thus they can communicate amongst themselves but not with containers in other apps.

   **Note:** It appears likely that this architecture was chosen for two reasons:

      A. The default Docker Bridged network does NOT provide DNS name resolution, whilst explicitly created bridge networks do; and
      B. Apps in the Apps store are generally stand-alone, and this Docker network model provides the greatest isolation of apps and thus the best security walls between apps.

2. Host Network - although the app has it's app-specific Docker network created, it is ***not*** connected to it and uses the Host IP address(es) instead.

To allow TrueNAS apps to communicate between themselves, TJ Horner created this utility,
and in its initial form to replicate the previous Kubernetes network-architecture,
creating a single shared Docker bridged network and connecting every non-Host-network app to it (CONNECT_ALL).
To assist further with this Kubernetes simulation, it provided backward-compatibility
with the old Kubernetes-based apps system for DNS names,
by adding a DNS-alias in the format `{service}.ix-{app-name}.svc.cluster.local` for each app.

A [subsequent improvement](https://github.com/tjhorner/dragonify/pull/3) by @casse-boubou
extended the original concept to allow the original CONNECT_ALL approach to be disabled,
and for individual containers to have a Docker Label defining a network for it to be connected to.
(This PR was never merged.)

A [further PR to the Casse-Boubou version](https://github.com/casse-boubou/dragonify/pull/1) by @EngTurtle
fixed a race condition whereby two containers starting at the same time,
and connecting to the same Dragonify network which needs to be created,
may both attempt to create this new network at the same time with one of these attempts failing
only because the other attempt succeeded.
This version also made some changes to improve security.

Finally, this current version by Sophist-UK is standing firmly on the shoulders of these three users,
consisting of a full rewrite in fully compliant TypeScript,
and allowing a number of alternative Docker-network architectures to be used
on a container-by-container basis.

## Technical Warnings

1. This Dragonify utility is a stop-gap until inter-app networking is fully implemented in TrueNAS Scale.
***See https://forums.truenas.com/t/inter-app-communication-in-24-10-electric-eel/22054 for a discussion about this.***

   ***WARNING:*** Dragonify introduces functionality that is unsupported by iXsystems. If you are having problems with your TrueNAS installation or its apps, please try stopping Dragonify and restarting all apps to see if the problem persists.

2. Dragonify achieves the target network reconfiguration by using the [Docker REST Api](https://docs.docker.com/reference/api/engine/version/v1.47),
to run the equivalent of `docker network connect` commands against already running containers.

   It does ***not*** update the TrueNAS application definitions to make the changes before the container starts.

   Because these commands change the container's network configuration at run-time ***after*** it has initialised,
the container needs to be able to recognise that it's configuration has changed and
reconfigure the container IP routing tables (and this may depend on what base O/S the container has been built upon) and
the app itself may need an ability to recognise and handle post-initialisation network changes.

   However, if you have such an app (which cannot handle network changes) you can always set it so that the other apps are added to the TrueNAS default network for that app.

## Change Log

| Author | Version |Image | Description
|-|-|-|-
| TJ Horner | v1.0 | [ghcr.io/tjhorner/dragonify:main](https://github.com/tjhorner/dragonify) | Connect all non-Host containers to a single shared bridged Docker network (CONNECT_ALL)
| Casse Boubou | v1.2 | [ghcr.io/casse-boubou/dragonify:main](https://github.com/casse-boubou/dragonify) | Allow individual containers to define their own Docker bridged network - allows multiple shared bridged Docker networks (CONNECT_ALL=false)
| EngTurtle | v1.2 | [ghcr.io/EngTurtle/dragonify:main](https://github.com/EngTurtle/dragonify) | Handle errors resulting from 2 or more parallel requests to create a new network (for e.g. multiple containers starting simultaneously in e.g. NextCloud), switch from pnpm to npm to avoid needing network connection (potential security issue),
| Sophist-UK | v2.0alpha | [ghcr.io/Sophist-UK/dragonify:main](https://github.com/Sophist-UK/dragonify) | As above plus completely refactored clean TS code, supporting additional Docker network approaches, much improved logging, filtered container start/stop event handling, clean termination by handling the Dragonify container terminate signal, internal tracking of networks and connected containers to avoid unnecessary Docker calls, plus github actions for linting and TypeScript code quality analysis.

**Note:** This table will be updated as v0.4 progresses and when image locations above are changed if/when PRs are merged.

## Docker Network approaches

This section is designed to give you a pictorial representation of the different ways you can use Dragonify
and details of how to set up Dragonify in each of the situations.

Whilst this is ***not*** a substitute for a detailed understanding of [Docker Networking](https://docs.docker.com/engine/network/),
it is hoped that this will be sufficient for you to decide which approach to use and how to set things up.

### TrueNAS Docker Default Networks

```mermaid
graph TD;
   A-->B;
   A-->C;
   B-->D;
   C-->D;
```

![TrueNas Docker Default Networks](.github/assets/truenas-docker-default-app-networks.png)

This diagram shows how TrueNAS defines Docker Networks for each of its apps.

TrueNAS creates a separate bridged network for each app,
and that bridged network has only that specific app's container(s) attached to it.
If you specify ports to be opened,
then these are opened on the Host IP address and port-forwarded to the bridged IP address.

It is possible for one container to request services from another container *on a different bridged network*,
however for that to work a port needs to be opened on the host for each of the services,
and this is considered a security risk (particularly in Enterprise and/or production environments)
because it means that a hacker can gain direct access to a back-end service through this open port.

For that reason, a lot of people want to continue to use some form of shared Docker network,
so that requests from one container to another can be made purely within a single Docker network
and without opening ports on the host that might be a security risk.

Hence, Dragonify was born as a means of bypassing the Docker Network restrictions
in the initial TrueNAS Docker Scale implementation.

**To-Do:** Update to confirm what happens if you have multiple containers with the same image?

### TrueNAS Docker Host Network

Before looking at what Dragonify can do, it is worth just documenting the only
alternative networking approach in TrueNAS Scale Electric Eel's Docker implementation,
"Host Networks".

![TrueNas Docker Host Network](.github/assets/truenas-docker-host-network.png)

When you create an App using the TrueNAS Scale UI, you generally have a checkbox that can be selected to use Host Network:

![TrueNAS App UI Host Network Checkbox](.github/assets/truenas-app-ui-host-network-check-box.png)

If you check this box, then the container does not use a bridged network, but instead is considered like a native app,
accessed directly using the host IP address(es). If you open ports for this app, these ports go directly to the container.

Dragonify ignores apps that use Host Networks and does not attempt to connect the container(s) to a Docker Network.

**Note:** If you specify a Dragonify Docker Label on a Host Network,
a log warning will be issued to notify you of this invalid combination,
but no network changes will be made regardless.

**Note:** If you select `Host Networks`,
despite not connecting the container(s) to it,
TrueNAS continues to create the aligned Docker Bridged Network.

### Dragonify `CONNECT_ALL = "true"` (default)

![Dragonify CONNECT_ALL](.github/assets/dragonify-connect-all-network.png)

This diagram shows how both earlier versions of TrueNAS that used Kubernetes
mapped apps to a single virtualised container network (except for Host Network apps of course),
and how the original Dragonify version mapped networks in later versions of TrueNAS that use Docker.

However this original implementation is a one-option approach,
and to provide greater flexibility @Casse-Boubou extended the functionality so that:
* if you specify an environment variable `CONNECT_ALL = "false"`, then
* for each container, you can define using a Docker Label (`tj.horner.dragonify.networks`)
the alternative network(s) you want Dragonify to connect the container to
* if you don't define such a label then Dragonify does nothing with the container,
leaving it on the default application-specific bridged network.

If you ***don't*** specify `CONNECT_ALL = "false"` as a Dragonify environment variable,
then (for backwards compatibility purposes) all later versions of Dragonify
will continue to connect all containers to a single common Docker bridged network (`apps-internal`).

### Dragonify `CONNECT_ALL = "false"`

However, in newer versions of Dragonify, by configuring `CONNECT_ALL = "false"`, instead of a single `apps-internal` bridged network,
you can now have several shared bridged networks for different groups of applications.

![Dragonify Dual Shared Networks](.github/assets/dragonify-dual-shared-networks.png)

You would achieve the above by defining setting Dragonify environment variable `CONNECT_ALL = "false"`
and setting a labels on the apps as follows:

* app-1/2/3 - `tj.horner.dragonify.networks = "group-1"`
* app-4/5/6 - `tj.horner.dragonify.networks = "group-2"`

### Dragonify Front-end + Isolated Back-ends

![Dragonify Front-end + Isolated Back-end](.github/assets/dragonify-isolated-backend-network.png)

This network design is a classical front-end/back-end network design,
isolating the back-end network from the network providing user access and
physically preventing users from having

You would achieve the above by defining setting Dragonify environment variable `CONNECT_ALL = "false"`
and setting a labels on the apps as follows:

* front-end - `tj.horner.dragonify.networks = "front-end-net,isolated-net:none"`
* service-1/2 - `tj.horner.dragonify.networks = "isolated-net:none"`

This model can also be used to e.g. route apps internet access through a VPN.

This is fine for situations which don't need admin access to the back-end apps,
but in many cases, especially for VPN situations,
you also want inbound admin access from the host / host network,
and for this you need a hybrid solution...

### Dragonify Front-end + Accessible Back-end

The trouble with a fully isolated back-end network is that you cannot access
e.g. an admin panel from the host in order to e.g. diagnose issues,
and instead are limited only to opening a Docker shell from within the TrueNAS host UI
(assuming that the container has been based on an O/S image that includes a shell).
If the app includes admin panels for the back-end,
then there is no way to access them and they are unusable.

An alternative is to have an isolated back-end network to connect to a VPN app
and / or that is only accessible from the front-end app,
and provide a separate, secondary bridged network for inbound access.
The key here is to ensure that outbound communications go through the isolated network
and not the bridged network(s).

![Dragonify Front-end + Accessible Back-end](.github/assets/dragonify-non-isolated-backend.png)

### Dragonify Container Attachment

![Dragonify Container Attached Network](.github/assets/dragonify-container-attached-network.png)

This networking approach is being described as a ***possible*** future enhancement
because it has some restrictions and difficulties.
Whilst it potentially might provide some capabilities
not achievable through any of the previous approaches,
attaching `app-2` to the `container:app-1` requires `app-1` to be running.
It is also unclear what happens to `app-2` if `app-1` stops running,
since `app-2` seems to rely on `app-1`'s iptables for packets to be forwarded to `app-2`.

### Dragonify Completely Isolated Container

![Dragonify Completely Isolated App](.github/assets/dragonify-completely-isolated-app.png)

## Docker visibility

Sophist recommends that people look to implement the TrueNAS app ***Arcane***
because it provides a nice UI which enables you to get a list of Containers and Networks,
and drill down to the details of each.

Whilst you can certainly get this information by running Docker commands from a sudo shell,
having a UI to navigate is significantly easier.

This can be very helpful to get more insight into TrueNAS' Docker infrastructure
than you can get from the TrueNAS apps UI,
and perhaps essential if you want to debug or contribute to Dragonify infrastructure.

## Installation

The following instructions assume that you are installing v0.4.
If you decide to install an earlier version,
then you will need to research how to vary the instructions below.

As yet, Dragonify has not made it to the TrueNAS Apps Store,
so you will need to install it as a Custom App in TrueNAS Scale,
and there are a couple of ways to do this after going to
the Apps page in the TrueNAS UI and clicking `Discover Apps`:

### Custom App screens...



### Custom Compose.yaml...

1. Click **⋮** in the top-right corner, then "Install via YAML".

2. Set the app-name to `dragonify`, and paste the following YAML into the text box.

```yaml
services:
  dragonify:
    image: ###choose image according to the version table above###
    restart: always
    environment:
      LOG_LEVEL: info # change to debug for more verbose logging
      CONNECT_ALL
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

Once started, all of your apps will now be connected on the same Docker network with DNS aliases for each service.

## Security Hardening

The Docker API does not have any security controls
other than limiting access to the API,
so you need to be confident that any app
which you give mapped access to the docker API socket
is safe to install.

The reason that this needs to be considered is because
through the Docker API a hacker could potentially
gain root access to your system
(for example, by downloading code from the internet and
then telling Docker to run it with root privileges).

To reduce or prevent these risks we have taken the following approach:

   * Making the socket read-only (to prevent it being deleted)
   * Making the code open-source (so that the Dragonify code can be independently reviewed)
   * Running Dragonify in a container that does NOT have any network access or host-mapped directories
   (thus preventing hacker's malicious code being inserted or downloaded from the internet)

Whilst we have done everything that we believe is possible to limit the risks
(and will respond positively to any Github issues or PRs which
identify or close further risks not previously identified)
you need to make your own decision about whether the remaining risk is acceptable.

**Note:** As previously noted, other Docker management tools such as Dockge and Portainer
use the same technology and have the same risks
(or perhaps greater risks since they **are** network connected).
We are simply being up-front and explicit about those risks
in order that users can make informed security decisions about using Dragonify.

## Technical Details

To facilitate inter-app communication, Dragonify creates a new Docker bridge network called `apps-internal`. It connects all existing TrueNAS-managed containers to the network, then starts listening for new containers to be started. When a new container is started, Dragonify will automatically connect it to the `apps-internal` network.

It is essentially running this command automatically for you (using postgres as an example):

```sh
docker network connect apps-internal --alias postgres.ix-postgres.svc.cluster.local ix-postgres-postgres-1
```

## License

MIT / ISC