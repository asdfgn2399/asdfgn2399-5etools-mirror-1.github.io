#!/bin/bash

set -e

if [[ $# -eq 0 ]]; then
    echo "No arguments provided. Usage: setEnvironment.sh"
    exit 999
fi

mkdir env
echo "export const environment = { firebaseApiKey : $1 }"  > env/env.js