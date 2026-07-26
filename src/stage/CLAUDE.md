# Stage supervisor contract

Stage supervises only services declared by loaded Packages. Core registers no product service. Desired state, process state, health, and activity are separate facts. Signals are sent only after validating process identity against runtime metadata.
